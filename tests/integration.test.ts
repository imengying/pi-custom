import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import compactWorkflow from "../extensions/compact-workflow/index.js";

const root = mkdtempSync(join(tmpdir(), "pi-workflow-test-"));
const cwd = join(root, "workspace");
mkdirSync(cwd);
afterAll(() => rmSync(root, { recursive: true, force: true }));
const tools = new Map<string, any>();
const handlers = new Map<string, any>();
const commands = new Map<string, any>();
const transforms: any[] = [];
compactWorkflow({
  on: (name: string, handler: any) => handlers.set(name, handler),
  registerTool: (tool: any) => tools.set(tool.name, tool),
  registerCommand: (name: string, command: any) => commands.set(name, command),
  registerMarkdownTransformer: (transform: any) => transforms.push(transform),
} as any);
const ctx: any = {
  cwd, hasUI: false, signal: undefined, model: undefined,
  sessionManager: { getBranch: () => [], getSessionId: () => "test", getSessionFile: () => undefined },
};

test("all entry points and display commands are installed", () => {
  expect([...tools.keys()].sort()).toEqual(["bash", "edit", "write"]);
  for (const name of ["tool_call", "user_bash", "message_update", "session_start"]) expect(handlers.has(name)).toBe(true);
  expect(commands.has("thoughts")).toBe(true);
  expect(commands.has("permissions")).toBe(true);
  expect(transforms).toHaveLength(1);
});

test("native safe shell execution still works", async () => {
  const args = { command: "printf '%s\\n' '中文 output' '$HOME'" };
  expect(await handlers.get("tool_call")({ toolCallId: "safe", toolName: "bash", input: args }, ctx)).toBeUndefined();
  const result = await tools.get("bash").execute("safe", args, undefined, undefined, ctx);
  expect(result.content[0].text).toContain("中文 output\n$HOME");
});

test("headless deletion cannot reach the native shell", async () => {
  const sentinel = join(cwd, "keep-me");
  writeFileSync(sentinel, "keep");
  const args = { command: "rm -f keep-me" };
  expect(await handlers.get("tool_call")({ toolCallId: "blocked", toolName: "bash", input: args }, ctx)).toMatchObject({ block: true });
  await expect(tools.get("bash").execute("blocked", args, undefined, undefined, ctx)).rejects.toThrow("未获得用户授权");
  expect(readFileSync(sentinel, "utf8")).toBe("keep");
});

test("manual ! commands also stop without approval", async () => {
  const result = await handlers.get("user_bash")({ command: "rm -f keep-me", cwd, excludeFromContext: false }, ctx);
  expect(result.result.cancelled).toBe(true);
  expect(result.result.exitCode).toBe(126);
  expect(existsSync(join(cwd, "keep-me"))).toBe(true);
});

test("ordinary writes preserve native result text and add an actual before/after diff", async () => {
  const path = "rewrite.txt";
  writeFileSync(join(cwd, path), "old line\nunchanged\n");
  const result = await tools.get("write").execute("write", { path, content: "new line\nunchanged\n" }, undefined, undefined, ctx);
  expect(readFileSync(join(cwd, path), "utf8")).toBe("new line\nunchanged\n");
  expect(result.content[0].text).toBe("Successfully wrote to rewrite.txt");
  expect(result.details.workflowDiff).toContain("-1 old line");
  expect(result.details.workflowDiff).toContain("+1 new line");
});

test("new files are rendered as additions", async () => {
  const result = await tools.get("write").execute("new", { path: "new-file.txt", content: "new content\n" }, undefined, undefined, ctx);
  expect(result.details.workflowDiff).toContain("+1 new content");
  expect(result.details.workflowDiff).not.toContain("-1");
});

test("native edit keeps its exact replacement behavior and diff", async () => {
  writeFileSync(join(cwd, "edit.txt"), "alpha\nbeta\n");
  const result = await tools.get("edit").execute("edit", {
    path: "edit.txt", edits: [{ oldText: "alpha", newText: "gamma" }],
  }, undefined, undefined, ctx);
  expect(readFileSync(join(cwd, "edit.txt"), "utf8")).toBe("gamma\nbeta\n");
  expect(result.details.diff).toContain("-1 alpha");
  expect(result.details.diff).toContain("+1 gamma");
});

test("native edit errors still propagate and leave the file unchanged", async () => {
  writeFileSync(join(cwd, "no-match.txt"), "keep\n");
  await expect(tools.get("edit").execute("bad-edit", {
    path: "no-match.txt", edits: [{ oldText: "absent", newText: "changed" }],
  }, undefined, undefined, ctx)).rejects.toThrow();
  expect(readFileSync(join(cwd, "no-match.txt"), "utf8")).toBe("keep\n");
});

test("outside writes are blocked before creating any file", async () => {
  const path = join(root, "must-not-exist");
  await expect(tools.get("write").execute("outside", { path, content: "no" }, undefined, undefined, ctx)).rejects.toThrow("未获得用户授权");
  expect(existsSync(path)).toBe(false);
});

test("large writes succeed with bounded diff computation", async () => {
  const content = "x".repeat(160000);
  const result = await tools.get("write").execute("large", { path: "large.txt", content }, undefined, undefined, ctx);
  expect(readFileSync(join(cwd, "large.txt"), "utf8")).toBe(content);
  expect(result.details.workflowDiffOmitted).toBe(true);
});

test("starting a new turn collapses command output", () => {
  let expanded = true;
  handlers.get("agent_start")({}, { ...ctx, hasUI: true, ui: { setToolsExpanded: (value: boolean) => { expanded = value; } } });
  expect(expanded).toBe(false);
});

test("session startup installs the Chinese menu and compact footer, and clears the old status", () => {
  const wrappers: any[] = [];
  const statuses: any[] = [];
  const footers: any[] = [];
  handlers.get("session_start")({}, {
    ...ctx, hasUI: true, mode: "tui",
    ui: {
      addAutocompleteProvider: (factory: any) => wrappers.push(factory),
      setToolsExpanded: () => {},
      setHiddenThinkingLabel: () => {},
      setStatus: (key: string, value: unknown) => statuses.push([key, value]),
      setFooter: (factory: any) => footers.push(factory),
    },
  });
  expect(wrappers).toHaveLength(1);
  expect(statuses).toEqual([["compact-workflow", undefined]]);
  expect(footers).toHaveLength(1);
});
