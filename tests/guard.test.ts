import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync, unlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { PermissionGate } from "../extensions/compact-workflow/guard.js";
import { setShellDialect } from "../extensions/compact-workflow/policy.js";

const root = mkdtempSync(join(tmpdir(), "pi-guard-test-"));
const cwd = join(root, "work");
mkdirSync(cwd);
afterAll(() => rmSync(root, { recursive: true, force: true }));
const context = (extra: any = {}): any => ({ cwd, hasUI: true, signal: undefined, ...extra });
const dangerous = { command: "rm -rf output" };

describe("permission decisions", () => {
  test("rejecting preflight blocks and terminates the tool", async () => {
    const gate = new PermissionGate(async () => false);
    expect(await gate.preflight("id", "bash", dangerous, context())).toMatchObject({ block: true, terminate: true });
    await expect(gate.beforeExecute("id", "bash", dangerous, context())).rejects.toThrow("未获得用户授权");
    expect(await gate.userCommand(dangerous.command, context())).toBeUndefined();
  });
  test("headless mode never asks or silently authorizes a risky operation", async () => {
    let prompts = 0;
    const gate = new PermissionGate(async () => { prompts++; return true; });
    const ctx = context({ hasUI: false });
    expect(await gate.preflight("id", "bash", dangerous, ctx)).toMatchObject({ block: true });
    await expect(gate.beforeExecute("id", "bash", dangerous, ctx)).rejects.toThrow();
    expect(await gate.userCommand(dangerous.command, ctx)).toBeUndefined();
    expect(prompts).toBe(0);
  });
  test("one approval only covers that exact call once", async () => {
    let prompts = 0;
    const gate = new PermissionGate(async () => { prompts++; return true; });
    expect(await gate.preflight("id", "bash", dangerous, context())).toBeUndefined();
    await gate.beforeExecute("id", "bash", dangerous, context());
    expect(prompts).toBe(1);
    await gate.beforeExecute("id", "bash", dangerous, context());
    expect(prompts).toBe(2);
  });
  test("changed command arguments require new approval", async () => {
    let prompts = 0;
    const gate = new PermissionGate(async () => ++prompts === 1);
    await gate.preflight("id", "bash", dangerous, context());
    await expect(gate.beforeExecute("id", "bash", { command: "rm -rf different" }, context())).rejects.toThrow();
    expect(prompts).toBe(2);
  });
  test("a safe preflight cannot authorize a later dangerous command", async () => {
    let prompts = 0;
    const gate = new PermissionGate(async () => { prompts++; return false; });
    await gate.preflight("id", "bash", { command: "pwd" }, context());
    await expect(gate.beforeExecute("id", "bash", dangerous, context())).rejects.toThrow();
    expect(prompts).toBe(1);
  });
  test("file approval shows the literal operation without extra labels", async () => {
    let body = "";
    let title = "";
    const gate = new PermissionGate(async (_ctx, heading, text) => { title = heading; body = text; return false; });
    await gate.preflight("id", "write", { path: "../outside-file", content: "preview" }, context());
    // The rule is named on the title row the dialog already draws; the body stays
    // label-free so the payload is never padded with extra lines.
    expect(title).toBe("需要用户授权 · 目录外");
    expect(body).toContain("preview");
    for (const label of ["完整操作", "原因:", "工作目录:", "实际目标:"]) expect(body).not.toContain(label);
  });
  test("the reason tag rides the existing title row and never names the tool", async () => {
    // `bash` is pi's tool name on every platform; naming it said nothing about the real
    // shell. The heading is the decision plus a short tag for the rule that asked, and
    // the tag is deliberately a couple of characters so it fits that row instead of
    // becoming another line of panel. The policy still follows the shell.
    const titles: string[] = [];
    const gate = new PermissionGate(async (_ctx, heading) => { titles.push(heading); return false; });
    try {
      setShellDialect("zsh", "/usr/bin/zsh");
      await gate.preflight("id", "bash", dangerous, context());
      expect(titles.at(-1)).toBe("需要用户授权 · 删除");
      setShellDialect("bash", undefined);
      await gate.preflight("id", "bash", { command: "sudo true" }, context());
      expect(titles.at(-1)).toBe("需要用户授权 · 提权");
      await gate.preflight("id", "write", { path: "../outside-file", content: "x" }, context());
      expect(titles.at(-1)).toBe("需要用户授权 · 目录外");
      // No tool name and no shell path may leak back into the heading, and the tag
      // stays short enough to share the title row rather than become its own line.
      for (const title of titles) {
        expect(title).not.toContain("bash");
        expect(title).not.toContain("zsh");
        expect(title.startsWith("需要用户授权 · ")).toBe(true);
        expect(visibleWidth(title.slice("需要用户授权 · ".length))).toBeLessThanOrEqual(6);
      }
    } finally {
      setShellDialect("bash", undefined);
    }
  });
  test("changing the symlink target invalidates write approval", async () => {
    const first = join(root, "first");
    const second = join(root, "second");
    mkdirSync(first);
    mkdirSync(second);
    const link = join(cwd, "target");
    symlinkSync(first, link);
    let prompts = 0;
    const gate = new PermissionGate(async () => ++prompts === 1);
    const input = { path: "target/file", content: "content" };
    await gate.preflight("id", "write", input, context());
    unlinkSync(link);
    symlinkSync(second, link);
    await expect(gate.beforeExecute("id", "write", input, context())).rejects.toThrow();
    expect(prompts).toBe(2);
  });
  test("approval UI errors fail closed", async () => {
    const gate = new PermissionGate(async () => { throw new Error("UI failure"); });
    expect(await gate.preflight("id", "bash", dangerous, context())).toMatchObject({ block: true });
    expect(await gate.userCommand(dangerous.command, context())).toBeUndefined();
  });
  test("aborted and reset prompts cannot approve later", async () => {
    let resolvePrompt!: (result: boolean) => void;
    const gate = new PermissionGate(() => new Promise((resolve) => { resolvePrompt = resolve; }));
    const controller = new AbortController();
    const decision = gate.preflight("id", "bash", dangerous, context({ signal: controller.signal }));
    await Promise.resolve();
    controller.abort();
    gate.reset();
    resolvePrompt(true);
    expect(await decision).toMatchObject({ block: true });
  });
  test("concurrent prompts are serialized", async () => {
    const pending: Array<(result: boolean) => void> = [];
    const gate = new PermissionGate(() => new Promise((resolve) => pending.push(resolve)));
    const first = gate.preflight("first", "bash", dangerous, context());
    const second = gate.preflight("second", "bash", dangerous, context());
    await Promise.resolve();
    expect(pending.length).toBe(1);
    pending[0](false);
    await first;
    await Promise.resolve();
    expect(pending.length).toBe(2);
    pending[1](false);
    expect(await second).toMatchObject({ block: true });
  });
  test("simple read commands need no prompt", async () => {
    let prompts = 0;
    const gate = new PermissionGate(async () => { prompts++; return false; });
    expect(await gate.preflight("safe", "bash", { command: "pwd" }, context())).toBeUndefined();
    expect((await gate.beforeExecute("safe", "bash", { command: "pwd" }, context())).safeCommand).toContain("/usr/bin/pwd");
    expect(prompts).toBe(0);
  });
});
