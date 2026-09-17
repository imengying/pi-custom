import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { loadThemeFromPath } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { installCompactFooter } from "../extensions/compact-workflow/compact-footer.js";
import { withRole } from "../extensions/compact-workflow/colors.js";
const theme = loadThemeFromPath(fileURLToPath(new URL(
  "../themes/codex-dark.json", import.meta.url,
)), "truecolor");
const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({ input, output, cacheRead, cacheWrite });

function fixture() {
  const entries: any[] = [
    { type: "message", message: { role: "assistant", usage: usage(173000, 172000, 17000000) } },
    { type: "message", message: { role: "user", content: "Hello" } },
    { type: "message", message: { role: "toolResult", usage: usage(500, 400) } },
    { type: "compaction", usage: usage(600, 500) },
    { type: "branch_summary", usage: usage(500, 500) },
    { type: "message", message: { role: "assistant", usage: usage(400, 600, 99500, 100) } },
  ];
  let footer: any;
  let branch = "main";
  let branchChanged = () => {};
  let renders = 0;
  let disposed = false;
  const statuses = new Map<string, string>();
  const context: any = { tokens: 17300, contextWindow: 1_000_000, percent: 1.73 };
  const ctx: any = {
    model: { id: "deepseek-v4.1-flash", provider: "work", reasoning: true, contextWindow: 1_000_000 },
    thinkingLevel: "high",
    getContextUsage: () => context,
    sessionManager: {
      getEntries: () => entries,
      getCwd: () => "/tmp/中文目录",
      getSessionName: () => "会话示例",
    },
    ui: {
      theme,
      setFooter: (factory: any) => {
        footer = factory({ requestRender: () => { renders++; } }, theme, {
          getGitBranch: () => branch,
          getExtensionStatuses: () => statuses,
          getAvailableProviderCount: () => 3,
          onBranchChange: (callback: () => void) => {
            branchChanged = callback;
            return () => { disposed = true; };
          },
        });
      },
    },
  };
  installCompactFooter(ctx);
  return {
    footer, ctx, entries, context, statuses,
    plain: (width = 120): string[] => footer.render(width).map(stripTerminalSequences),
    changeBranch: (next: string) => { branch = next; branchChanged(); },
    renderCount: () => renders,
    isDisposed: () => disposed,
  };
}

test("footer totals include tools and summaries, with the latest prompt cache hit rate", () => {
  const { plain } = fixture();
  const lines = plain();
  expect(lines[1]).toMatch(/^↑ 175k {3}↓ 174k {3}\u{f1632} 99\.5% {3}17\.3k\/1M\s+deepseek-v4\.1-flash • high$/u);
  expect(lines.join("\n")).not.toMatch(/\||\(work\)|CH|R17M|\(auto\)|授权检查已启用/);
});

test("context uses actual tokens and stays unknown after compaction", () => {
  const { plain, context, footer } = fixture();
  Object.assign(context, { tokens: 173000, percent: 17.3 });
  expect(plain()[1]).toContain("173k/1M");
  Object.assign(context, { tokens: null, percent: null });
  expect(plain()[1]).toContain("?/1M");
  expect(plain()[1]).not.toContain("173k");
  for (const [tokens, percent, color] of [[750000, 75, "warning"], [950000, 95, "error"]] as const) {
    Object.assign(context, { tokens, percent });
    expect(footer.render(120)[1]).toContain(theme.fg(color, `${tokens / 1000}k/1M`));
  }
});

test("new usage and model changes refresh without carrying stale cache statistics", () => {
  const { plain, ctx, entries } = fixture();
  entries.push({ type: "message", message: { role: "assistant", usage: usage(1000, 1000) } });
  ctx.model = { id: "另一个模型", provider: "second", reasoning: false };
  expect(plain()[1]).toMatch(/^↑ 176k {3}↓ 175k {3}\u{f1632} 0\.0%/u);
  expect(plain()[1]).toContain("另一个模型");
  expect(plain()[1]).not.toContain("second");
  expect(plain()[1]).not.toContain("deepseek");
  entries.push({ type: "message", message: { role: "assistant", usage: usage(0, 0) } });
  expect(plain()[1]).toContain("\u{f1632} —");
  expect(plain()[1]).not.toContain("NaN");
});

test("each status field carries the accent codex assigns to it", () => {
  // codex's style guide colours status items by kind rather than painting the
  // whole row one grey: model cyan, path green, branch magenta, usage green.
  const { footer } = fixture();
  const lines = footer.render(120);
  expect(lines[0]).toContain(theme.fg("success", "/tmp/中文目录"));
  expect(lines[0]).toContain(withRole(theme, "branch", "dim", "main"));
  expect(lines[0]).toContain(theme.fg("muted", "会话示例"));
  expect(lines[1]).toContain(theme.fg("success", "↑ 175k"));
  expect(lines[1]).toContain(theme.fg("success", "↓ 174k"));
  expect(lines[1]).toContain(theme.fg("success", "\u{f1632} 99.5%"));
  expect(lines[1]).toContain(theme.fg("accent", "deepseek-v4.1-flash • high"));
  // Colouring must not change layout: the plain text still starts with the four
  // usage fields and ends with the model, at exactly the full width. (The cache
  // glyph is double-width, so pad by display width, not string length.)
  const plain = stripTerminalSequences(lines[1]);
  const usageText = "↑ 175k   ↓ 174k   \u{f1632} 99.5%   17.3k/1M";
  expect(plain.startsWith(usageText)).toBe(true);
  expect(plain.endsWith("deepseek-v4.1-flash • high")).toBe(true);
  expect(visibleWidth(lines[1])).toBe(120);
});

test("pi's own themes lack the magenta roles and fall back instead of throwing", () => {
  // codex-dark is the only theme defining `bashPrompt` and `branch`, and both are absent
  // from pi's `ThemeColor` union. A user who switches to a built-in theme would otherwise
  // crash the renderer, so the fallback path is exercised against pi's real dark theme
  // rather than a stub that only pretends to throw.
  const { footer, ctx } = fixture();
  ctx.ui.theme = loadThemeFromPath(fileURLToPath(new URL(
    "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/dark.json", import.meta.url,
  )), "truecolor");
  const lines = footer.render(120);
  // The branch still renders, in the fallback colour rather than magenta.
  expect(stripTerminalSequences(lines[0])).toContain("main");
  expect(stripTerminalSequences(lines[1])).toContain("deepseek-v4.1-flash • high");
});

test("a whole token figure drops the decimal, a fractional one keeps it", () => {
  // `256.0k` / `1.0M` read as noise; the decimal only appears when it says something.
  const { ctx, context, plain } = fixture();
  // `tokens: null` is the post-compaction unknown state, which is the `?` case.
  Object.assign(context, { tokens: null, percent: null });
  for (const [window, expected] of [[256_000, "256k"], [200_000, "200k"], [1_000_000, "1M"], [2_000_000, "2M"]] as const) {
    context.contextWindow = window;
    ctx.model.contextWindow = window;
    expect(plain()[1]).toContain(`?/${expected}`);
    expect(plain()[1]).not.toContain(".0k");
    expect(plain()[1]).not.toContain(".0M");
  }
  // A genuine fraction must survive rounding down to one decimal.
  context.contextWindow = 1_048_576;
  Object.assign(context, { tokens: null, percent: null });
  expect(plain()[1]).toContain("?/1M");
  context.contextWindow = 250_000;
  Object.assign(context, { tokens: 256_000 });
  expect(plain()[1]).toContain("256k/250k");
  Object.assign(context, { tokens: 256_500 });
  expect(plain()[1]).toContain("256.5k/250k");
});

test("Chinese paths, database glyph, and extension status fit narrow terminals", () => {
  const { footer, statuses, plain } = fixture();
  statuses.set("other-extension", theme.fg("success", "其他状态\n进度"));
  for (const width of [1, 2, 10, 24, 40, 80, 120]) {
    expect(footer.render(width).every((line: string) => visibleWidth(line) <= width)).toBe(true);
    expect(plain(width).every((line) => !/[\r\n\t]/.test(line))).toBe(true);
  }
  expect(plain()[0]).toBe("/tmp/中文目录 (main) • 会话示例");
  expect(plain()[2]).toBe("其他状态 进度");
  expect(footer.render(0)).toEqual([]);
});

test("branch changes redraw and the watcher is released when the footer is disposed", () => {
  const current = fixture();
  current.changeBranch("feature");
  expect(current.renderCount()).toBe(1);
  expect(current.plain()[0]).toContain("(feature)");
  current.footer.dispose();
  expect(current.isDisposed()).toBe(true);
});
