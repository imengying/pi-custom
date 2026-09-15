import { describe, expect, jest, test } from "bun:test";
import { AssistantMessageComponent, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { compositeTuiLine, visibleWidth, stripTerminalSequences } from "@earendil-works/pi-tui";
import { loadThemeFromPath, setThemeInstance } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { compactThinking, ReviewDialog, reviewText, showReview } from "../extensions/compact-workflow/ui.js";
import { CommandOutputComponent, DiffComponent, diffCounts, shellRenderers } from "../extensions/compact-workflow/renderers.js";
import { fileURLToPath } from "node:url";

const theme = loadThemeFromPath(fileURLToPath(new URL(
  "../themes/codex-dark.json", import.meta.url,
)), "truecolor");
setThemeInstance(theme);
const plain = (lines: string[]) => lines.map(stripTerminalSequences).join("\n");

describe("thinking preview", () => {
  for (const width of [24, 40, 100]) {
    test("streaming at width " + width + " stays compact and refreshes", () => {
      const first = "最初的思考\n" + "旧内容，长中文与 emoji 🙂。".repeat(100);
      const original: any = {
        role: "assistant", content: [{ type: "thinking", thinking: first }],
        stopReason: "stop",
      };
      const component = new AssistantMessageComponent(original, false, getMarkdownTheme(), "Thinking…", 1, [compactThinking]);
      component.updateContent(original, true);
      const initial = component.render(width);
      expect(initial.length).toBeLessThanOrEqual(8);
      expect(plain(initial)).not.toContain("最初的思考");
      const updated = { ...original, content: [{ type: "thinking", thinking: first + "\n最新进度 ABCD" }] };
      component.updateContent(updated, true);
      const current = component.render(width);
      expect(plain(current)).toContain("ABCD");
      expect(plain(current)).not.toBe(plain(initial));
      expect(current.every((line) => visibleWidth(line) <= width)).toBe(true);
      expect(original.content[0].thinking).toBe(first);
      component.updateContent(updated, false);
      const complete = plain(component.render(width));
      expect(complete).toContain("思考完成");
      expect(complete).not.toContain("ABCD");
    });
  }
  test("normal answer markdown is untouched", () => {
    const markdown = "# Answer\n\nA code block and **bold**";
    expect(compactThinking(markdown, { messageType: "assistant", availableWidth: 40, isStreaming: true })).toBe(markdown);
  });
});

describe("command and diff rendering", () => {
  for (const width of [24, 40, 100]) {
    test("command preview and expansion at " + width, () => {
      const output = Array.from({ length: 30 }, (_, i) => "line-" + i + " 中文输出").join("\n");
      const collapsed = new CommandOutputComponent(output, false, theme).render(width);
      expect(collapsed.length).toBeLessThanOrEqual(7);
      expect(plain(collapsed)).toContain("line-29");
      expect(plain(collapsed)).not.toContain("line-0 ");
      const full = new CommandOutputComponent(output, true, theme).render(width);
      expect(plain(full)).toContain("line-0 ");
      expect(plain(full)).toContain("line-29");
      expect([...collapsed, ...full].every((line) => visibleWidth(line) <= width)).toBe(true);
    });
    test("long lines cannot expand a collapsed command unboundedly at " + width, () => {
      const rendered = new CommandOutputComponent("中文内容🙂".repeat(1000) + " END", false, theme).render(width);
      expect(rendered.length).toBeLessThanOrEqual(7);
      expect(plain(rendered)).toContain("END");
      expect(rendered.every((line) => visibleWidth(line) <= width)).toBe(true);
    });
    test("diff has visible deletions and additions with bounded preview at " + width, () => {
      const diff = Array.from({ length: 30 }, (_, i) => "-" + (i + 1) + " 删除旧中文内容").join("\n") + "\n" +
        Array.from({ length: 30 }, (_, i) => "+" + (i + 1) + " 新增中文内容").join("\n");
      const collapsed = new DiffComponent(diff, false, theme).render(width);
      expect(plain(collapsed)).toContain("删除");
      expect(plain(collapsed)).toContain("新增");
      expect(plain(collapsed)).toContain("+30");
      expect(plain(collapsed)).toContain("−30");
      expect(collapsed.length).toBeLessThanOrEqual(17);
      expect(collapsed.join("\n")).toContain("\x1b[48;");
      const full = new DiffComponent(diff, true, theme).render(width);
      expect(plain(full)).toContain("+30 新增");
      expect(plain(full)).toContain("-30 删除");
      expect([...collapsed, ...full].every((line) => visibleWidth(line) <= width)).toBe(true);
    });
  }
  test("multi-line command arguments stay collapsed too", () => {
    const rendered = shellRenderers.renderCall!({ command: "python3 - <<'PY'\nprint('one')\nprint('two')\nPY" }, theme, {
      state: {}, expanded: false, isPartial: true,
    } as any).render(60);
    expect(rendered.length).toBe(1);
    expect(plain(rendered)).not.toContain("print");
    expect(plain(rendered)).toContain("4 行命令");
  });
  test("diff headers are not counted as changed lines", () => {
    expect(diffCounts("--- a/file\n+++ b/file\n-old\n+new")).toEqual({ added: 1, removed: 1 });
  });
});

describe("review dialog", () => {
  const make = (approval = true) => {
    const decisions: boolean[] = [];
    const body = Array.from({ length: 100 }, (_, i) => "行 " + i + "：完整命令预览").join("\n");
    const dialog = new ReviewDialog("授权", body, theme, approval, () => 24, () => {}, (value) => decisions.push(value));
    return { dialog, decisions };
  };
  for (const key of ["\x1b", "\x03", "n", "2"]) {
    test("explicit rejection: " + JSON.stringify(key), () => {
      const { dialog, decisions } = make();
      dialog.handleInput(key);
      expect(decisions).toEqual([false]);
    });
  }
  for (const key of ["a", "\x1b[97u", "1", "\r", "\x1b[13u"]) {
    test("explicit approval key: " + JSON.stringify(key), () => {
      const { dialog, decisions } = make();
      dialog.handleInput(key);
      expect(decisions).toEqual([true]);
    });
  }
  test("Enter confirms the visible selection", () => {
    const { dialog, decisions } = make();
    expect(plain(dialog.render(80))).toContain("› 1. 允许本次操作");
    dialog.handleInput("\x1b[B");
    expect(plain(dialog.render(80))).toContain("› 2. 拒绝并停止");
    expect(decisions).toEqual([]);
    dialog.handleInput("\r");
    expect(decisions).toEqual([false]);
  });
  test("selection can move back to allow without granting access until confirmed", () => {
    const { dialog, decisions } = make();
    dialog.handleInput("\t");
    dialog.handleInput("\x1b[A");
    expect(decisions).toEqual([]);
    expect(plain(dialog.render(80))).toContain("› 1. 允许本次操作");
    dialog.handleInput("\r");
    expect(decisions).toEqual([true]);
  });
  test("Enter closes a read-only review without approval", () => {
    const { dialog, decisions } = make(false);
    dialog.handleInput("\r");
    expect(decisions).toEqual([false]);
  });
  test("paste and unrelated keys cannot approve", () => {
    const { dialog, decisions } = make();
    dialog.handleInput("a\n");
    dialog.handleInput("\x1b[200~a\x1b[201~");
    dialog.handleInput("\x1b[200~\r\x1b[201~");
    dialog.handleInput("\x1b[13;1:2u");
    dialog.handleInput("\x1b[97;1:3u");
    expect(decisions).toEqual([]);
    dialog.dispose();
  });
  for (const width of [24, 40, 100]) {
    test("opaque panel preserves both choices after scrolling and resizing at width " + width, () => {
      let rows = 24;
      const dialog = new ReviewDialog("需要用户授权", "中文🙂\n".repeat(90) + "LAST", theme, true, () => rows, () => {}, () => {});
      for (const height of [24, 10, 6, 3, 18]) {
        rows = height;
        dialog.render(width);
        dialog.handleInput("\x1b[F");
        const rendered = dialog.render(width);
        expect(rendered.length).toBeLessThanOrEqual(height);
        expect(rendered.every((line) => visibleWidth(line) === width)).toBe(true);
        expect(rendered.every((line) => line.startsWith(theme.getBgAnsi("userMessageBg")))).toBe(true);
        expect(plain(rendered)).toContain("1. 允许本次操作");
        expect(plain(rendered)).toContain("2. 拒绝并停止");
        if (height >= 6) expect(plain(rendered)).toContain("LAST");
        for (const line of rendered) {
          const composed = compositeTuiLine("BACKGROUND".repeat(width), line, 0, width, width);
          expect(stripTerminalSequences(composed)).not.toContain("BACKGROUND");
        }
      }
      dialog.dispose();
    });
  }
  test("bottom approval remains pending after an hour and restores working status", async () => {
    jest.useFakeTimers();
    let dialog!: ReviewDialog;
    const statuses: Array<string | undefined> = [];
    const ctx: any = { hasUI: true, ui: {
      setWorkingMessage: (message?: string) => statuses.push(message),
      custom: (factory: any, options: any) => new Promise((resolve) => {
        expect(options).toEqual({ overlay: true, overlayOptions: { width: "100%", anchor: "bottom-center" } });
        dialog = factory({ terminal: { rows: 24 }, requestRender: () => {} }, theme, {}, resolve);
      }),
    } };
    try {
      let settled = false;
      const result = showReview(ctx, "需要用户授权", "echo test", true).then((value) => { settled = true; return value; });
      jest.advanceTimersByTime(60 * 60 * 1000);
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(plain(dialog.render(100))).toContain("等待确认，无超时");
      expect(statuses).toEqual(["等待用户授权"]);
      dialog.handleInput("\r");
      expect(await result).toBe(true);
      expect(statuses).toEqual(["等待用户授权", undefined]);
    } finally {
      dialog?.dispose();
      jest.useRealTimers();
    }
  });
  test("UI failure restores working status and propagates to the permission gate", async () => {
    const statuses: Array<string | undefined> = [];
    const ctx: any = { hasUI: true, ui: {
      setWorkingMessage: (message?: string) => statuses.push(message),
      custom: async () => { throw new Error("UI failed"); },
    } };
    await expect(showReview(ctx, "授权", "operation", true)).rejects.toThrow("UI failed");
    expect(statuses).toEqual(["等待用户授权", undefined]);
  });
  test("all command lines can be reviewed by scrolling", () => {
    const { dialog } = make();
    expect(plain(dialog.render(40))).not.toContain("行 99");
    dialog.handleInput("\x1b[F");
    const end = dialog.render(40);
    expect(plain(end)).toContain("行 99");
    expect(end.length).toBeLessThanOrEqual(24);
    expect(end.every((line) => visibleWidth(line) <= 40)).toBe(true);
    dialog.dispose();
  });
  test("approval has no hidden terminal or bidi controls", () => {
    const body = reviewText("safe\u0008\u001b[2K\u202e rm -rf x");
    expect(body).toContain("\\u0008");
    expect(body).toContain("\\u001b");
    expect(body).toContain("\\u202e");
    expect(body).not.toContain("\x1b");
  });
  test("cancellation settles the dialog as rejected", () => {
    const controller = new AbortController();
    const results: boolean[] = [];
    const dialog = new ReviewDialog("授权", "rm -rf x", theme, true, () => 24, () => {}, (value) => results.push(value), controller.signal);
    controller.abort();
    dialog.handleInput("a");
    expect(results).toEqual([false]);
  });
});
