import { describe, expect, test } from "bun:test";
import { AssistantMessageComponent, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, stripTerminalSequences } from "@earendil-works/pi-tui";
import { loadThemeFromPath, setThemeInstance } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { compactThinking, ReviewDialog, reviewText } from "../extensions/compact-workflow/ui.js";
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
  for (const key of ["\r", "\x1b", "\x03"]) {
    test("Enter, Escape and Ctrl+C reject: " + JSON.stringify(key), () => {
      const { dialog, decisions } = make();
      dialog.handleInput(key);
      expect(decisions).toEqual([false]);
    });
  }
  for (const key of ["a", "\x1b[97u"]) {
    test("explicit approval key: " + JSON.stringify(key), () => {
      const { dialog, decisions } = make();
      dialog.handleInput(key);
      expect(decisions).toEqual([true]);
    });
  }
  test("paste and unrelated keys cannot approve", () => {
    const { dialog, decisions } = make();
    dialog.handleInput("a\n");
    dialog.handleInput("\x1b[200~a\x1b[201~");
    expect(decisions).toEqual([]);
    dialog.dispose();
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
