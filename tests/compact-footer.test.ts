import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { loadThemeFromPath } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { installCompactFooter } from "../extensions/compact-workflow/compact-footer.js";

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
  expect(lines[1]).toMatch(/^↑ 175k {3}↓ 174k {3}\u{f1632} 99\.5% {3}17\.3k\/1\.0M\s+deepseek-v4\.1-flash • high$/u);
  expect(lines.join("\n")).not.toMatch(/\||\(work\)|CH|R17M|\(auto\)|授权检查已启用/);
});

test("context uses actual tokens and stays unknown after compaction", () => {
  const { plain, context, footer } = fixture();
  Object.assign(context, { tokens: 173000, percent: 17.3 });
  expect(plain()[1]).toContain("173k/1.0M");
  Object.assign(context, { tokens: null, percent: null });
  expect(plain()[1]).toContain("?/1.0M");
  expect(plain()[1]).not.toContain("173k");
  for (const [tokens, percent, color] of [[750000, 75, "warning"], [950000, 95, "error"]] as const) {
    Object.assign(context, { tokens, percent });
    expect(footer.render(120)[1]).toContain(theme.fg(color, `${tokens / 1000}k/1.0M`));
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
