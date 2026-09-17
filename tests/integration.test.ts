import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import compactWorkflow from "../extensions/compact-workflow/index.js";
import { PermissionGate } from "../extensions/compact-workflow/guard.js";

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

test("each user_bash command is authorized independently", async () => {
  const seen: string[] = [];
  const gate = new PermissionGate(async (_ctx, _title, body) => { seen.push(body); return true; });
  const interactive = { ...ctx, hasUI: true };
  expect(await gate.userCommand("rm -f keep-me", interactive)).toBeDefined();
  // The handler re-validates the command it actually runs, so a hook that swaps in
  // a different command cannot inherit the earlier approval.
  const swapped = await gate.userCommand("rm -rf /", interactive);
  expect(seen).toEqual(["rm -f keep-me", "rm -rf /"]);
  expect(swapped?.approval).toBe(true);
});

test("manual ! commands also stop without approval", async () => {
  const result = await handlers.get("user_bash")({ command: "rm -f keep-me", cwd, excludeFromContext: false }, ctx);
  expect(result.result.cancelled).toBe(true);
  expect(result.result.exitCode).toBe(126);
  expect(existsSync(join(cwd, "keep-me"))).toBe(true);
});

test("a manual ! command asks once and then runs the rewritten command", async () => {
  // The operations.exec hook used to re-run the whole approval, so every `!` command
  // that needs one asked twice. An unchanged command is already authorized; only a
  // different string (another hook rewriting it) goes back to the user.
  let panels = 0;
  const interactive = {
    ...ctx,
    hasUI: true,
    ui: { custom: async () => { panels++; return true; }, setWorkingMessage: () => {} },
  };
  const command = "rm -f never-created";
  const handler = await handlers.get("user_bash")({ command, cwd, excludeFromContext: false }, interactive);
  expect(panels).toBe(1);
  // Executing exactly what the user approved must not ask again.
  await handler.operations.exec(command, cwd, { onData: () => {} }).catch(() => {});
  expect(panels).toBe(1);
});

test("a command rewritten after approval asks again", async () => {
  let panels = 0;
  const interactive = {
    ...ctx,
    hasUI: true,
    ui: { custom: async () => { panels++; return true; }, setWorkingMessage: () => {} },
  };
  const handler = await handlers.get("user_bash")({ command: "rm -f never-created", cwd, excludeFromContext: false }, interactive);
  expect(panels).toBe(1);
  // A different string reaching exec cannot inherit the first approval.
  await handler.operations.exec("rm -rf /nonexistent-target", cwd, { onData: () => {} }).catch(() => {});
  expect(panels).toBe(2);
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

test("a shell prefix survives the rewrite without a second panel", async () => {
  // pi prepends shellCommandPrefix before calling operations.exec. Reusing the bare
  // command's rewritten form would drop it, and re-approving the whole string would
  // make every `!` command ask twice.
  const settingsPath = join(process.env.HOME ?? "/tmp", ".pi", "agent", "settings.json");
  const previous = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : undefined;
  try {
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({ ...(previous ? JSON.parse(previous) : {}), shellCommandPrefix: "echo PREFIX-SENTINEL" }));
    handlers.get("session_start")({}, { ...ctx, hasUI: false });
    let panels = 0;
    const interactive = {
      ...ctx,
      hasUI: true,
      ui: { custom: async () => { panels++; return true; }, setWorkingMessage: () => {} },
    };
    const command = "mkdir made-by-rewrite";
    const handler = await handlers.get("user_bash")({ command, cwd, excludeFromContext: false }, interactive);
    expect(panels).toBe(1);
    let output = "";
    await handler.operations.exec(`echo PREFIX-SENTINEL\n${command}`, cwd, { onData: (data: Buffer) => { output += data.toString(); } });
    expect(output).toContain("PREFIX-SENTINEL");
    expect(existsSync(join(cwd, "made-by-rewrite"))).toBe(true);
  } finally {
    if (previous === undefined) rmSync(settingsPath, { force: true });
    else writeFileSync(settingsPath, previous);
    handlers.get("session_start")({}, { ...ctx, hasUI: false });
  }
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

test("bash override keeps a user-configured shell prefix working", async () => {
  // Approval is exercised elsewhere; this test isolates shell-configuration plumbing.
  const approving = { ...ctx, hasUI: true };
  // pi applies shellCommandPrefix before running the built-in bash tool. Overriding
  // that tool replaces the default, so the extension must read the same settings.
  const settingsPath = join(process.env.HOME ?? "/tmp", ".pi", "agent", "settings.json");
  const previous = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : undefined;
  try {
    mkdirSync(dirname(settingsPath), { recursive: true });
    // The prefix is prepended verbatim by pi, so a literal marker is enough to prove
    // it survived the override. (A `$VAR` command would ask for approval instead.)
    writeFileSync(settingsPath, JSON.stringify({ shellCommandPrefix: "printf 'PREFIX-RAN\n'" }));
    // Settings are cached per directory so a lock is not taken on every call;
    // session start (what /reload emits) is what makes pi re-read them.
    handlers.get("session_start")({}, { ...ctx, hasUI: false });
    const args = { command: "printf 'command-ran'" };
    expect(await handlers.get("tool_call")({ toolCallId: "prefix", toolName: "bash", input: args }, approving)).toBeUndefined();
    const result = await tools.get("bash").execute("prefix", args, undefined, undefined, approving);
    expect(result.content[0].text).toContain("PREFIX-RAN");
    expect(result.content[0].text).toContain("command-ran");
  } finally {
    if (previous === undefined) rmSync(settingsPath, { force: true });
    else writeFileSync(settingsPath, previous);
  }
});

test("a zsh shellPath switches the approval dialect to zsh", async () => {
  const settingsPath = join(process.env.HOME ?? "/tmp", ".pi", "agent", "settings.json");
  const previous = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : undefined;
  try {
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({ shellPath: "/usr/bin/zsh" }));
    handlers.get("session_start")({}, { ...ctx, hasUI: false });
    // `=cmd` is expanded by zsh but not bash, so it must now need approval.
    const zshOnly = { command: "printf '%s' =ls" };
    const blocked = await handlers.get("tool_call")({ toolCallId: "zsh", toolName: "bash", input: zshOnly }, ctx);
    expect(blocked).toMatchObject({ block: true });
    // A quoted `=` stays literal in zsh, so it keeps working without approval.
    const quoted = { command: "printf '%s' '=ls'" };
    expect(await handlers.get("tool_call")({ toolCallId: "quoted", toolName: "bash", input: quoted }, ctx)).toBeUndefined();
  } finally {
    if (previous === undefined) rmSync(settingsPath, { force: true });
    else writeFileSync(settingsPath, previous);
    handlers.get("session_start")({}, { ...ctx, hasUI: false });
  }
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
