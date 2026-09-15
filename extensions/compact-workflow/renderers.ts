import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { highlightCode, keyHint } from "@earendil-works/pi-coding-agent";
import { getCapabilities, Text, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { withRole } from "./colors.js";
import { COMMAND_PREVIEW_LINES, DIFF_PREVIEW_LINES, displayText, padLine } from "./ui.js";

type Renderers = Required<Pick<ToolDefinition<any, any, any>, "renderCall" | "renderResult">>;
type DiffKind = "added" | "removed" | "context";
interface DiffRow { text: string; kind: DiffKind }

/**
 * How long a command actually ran, keyed by tool call id.
 *
 * pi announces the tool call before it asks for approval, so anything timed from
 * the call's own first render would silently include however long the user took to
 * answer the dialog. Timing is therefore recorded around the real execution in
 * `index.ts` and read back here. Entries deliberately outlive the tool call: the
 * final render happens after execution ends, and a late re-render (expand, resize)
 * must keep reporting the same number instead of recomputing it.
 */
const executionTimes = new Map<string, number>();
const EXECUTION_TIME_LIMIT = 200;

export function recordExecutionTime(toolCallId: string, durationMs: number): void {
  // Re-inserting keeps the most recently finished calls at the end of the map.
  executionTimes.delete(toolCallId);
  executionTimes.set(toolCallId, durationMs);
  while (executionTimes.size > EXECUTION_TIME_LIMIT) {
    const oldest = executionTimes.keys().next().value;
    if (oldest === undefined) break;
    executionTimes.delete(oldest);
  }
}

/**
 * Syntax-highlight a shell command for display, one entry per source line.
 *
 * codex colours the command body rather than printing it flat. The input is
 * already sanitised by `displayText`, so the only escape sequences added here
 * come from pi's own highlighter. A line may end mid-token (an unterminated
 * quote, a here-doc opener), and the highlighter then leaves its colour open;
 * every line is closed again so the following text cannot inherit it. An
 * unrecognised command highlights as plain text, and `stripTerminalSequences`
 * always round-trips to the original characters.
 */
function highlightShellLines(text: string): string[] {
  let lines: string[];
  try {
    lines = highlightCode(text, "bash");
  } catch {
    lines = text.split("\n");
  }
  return lines.map((line) => (line.includes("\u001b[") && !line.endsWith("\u001b[39m") ? line + "\u001b[39m" : line));
}

function highlightShell(text: string): string {
  return highlightShellLines(text).join("\n");
}

/** Status marks are `bold` in codex, on top of their green/red role. */
function statusMark(theme: Theme, isPartial: boolean, isError: boolean): string {
  if (isPartial) return theme.fg("muted", "●");
  return theme.fg(isError ? "error" : "success", theme.bold(isError ? "×" : "✓"));
}

function resultText(result: { content?: Array<{ type: string; text?: string }> }): string {
  return displayText((result.content ?? []).filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n")).trimEnd();
}

function diffKind(line: string): DiffKind {
  if (/^(\+\+\+|---)(?:\s|$)/.test(line)) return "context";
  return line.startsWith("+") ? "added" : line.startsWith("-") ? "removed" : "context";
}

export function diffCounts(diff: string): { added: number; removed: number } {
  const lines = diff.split("\n");
  return {
    added: lines.filter((line) => diffKind(line) === "added").length,
    removed: lines.filter((line) => diffKind(line) === "removed").length,
  };
}

export class DiffComponent {
  constructor(private diff: string, private expanded: boolean, private theme: Theme) {}
  invalidate(): void {}
  render(width: number): string[] {
    if (width <= 0) return [];
    const counts = diffCounts(this.diff);
    const rows: DiffRow[] = displayText(this.diff).split("\n").flatMap((text) =>
      wrapTextWithAnsi(text, width).map((line) => ({ text: line, kind: diffKind(text) })),
    );
    let visible = rows;
    if (!this.expanded && rows.length > DIFF_PREVIEW_LINES) {
      const removed = rows.filter((row) => row.kind === "removed");
      const added = rows.filter((row) => row.kind === "added");
      if (removed.length && added.length) {
        // Large rewrites should still show both old and new content.
        const selected = new Set([
          ...removed.slice(0, DIFF_PREVIEW_LINES / 2),
          ...added.slice(0, DIFF_PREVIEW_LINES / 2),
        ]);
        visible = rows.filter((row) => selected.has(row));
      } else {
        const start = Math.max(0, rows.findIndex((row) => row.kind !== "context") - 2);
        visible = rows.slice(start, start + DIFF_PREVIEW_LINES);
      }
    }
    const summary = this.theme.fg("toolDiffAdded", "+" + counts.added) + " " +
      this.theme.fg("toolDiffRemoved", "−" + counts.removed);
    const result = ["", truncateToWidth(summary, width)];
    const trueColor = getCapabilities().trueColor;
    for (const row of visible) {
      if (row.kind === "context") {
        result.push(this.theme.fg("toolDiffContext", row.text));
      } else {
        const added = row.kind === "added";
        // Codex's dark diff tints: #213a2b for additions, #4a221d for deletions.
        const bg = trueColor ? (added ? "\x1b[48;2;33;58;43m" : "\x1b[48;2;74;34;29m")
          : (added ? "\x1b[48;5;22m" : "\x1b[48;5;52m");
        result.push(bg + this.theme.fg(added ? "toolDiffAdded" : "toolDiffRemoved", padLine(row.text, width)) + "\x1b[49m");
      }
    }
    if (visible.length < rows.length) {
      result.push(truncateToWidth(this.theme.fg("muted", "… 已收起 " + (rows.length - visible.length) + " 行 · ") +
        keyHint("app.tools.expand", "展开"), width));
    }
    return result;
  }
}

export class CommandOutputComponent {
  constructor(private output: string, private expanded: boolean, private theme: Theme, private footer?: string) {}
  invalidate(): void {}
  render(width: number): string[] {
    if (width <= 0) return [];
    const all = this.output ? wrapTextWithAnsi(displayText(this.output).trimEnd(), width) : [];
    const shown = this.expanded ? all : all.slice(-COMMAND_PREVIEW_LINES);
    const result: string[] = [];
    if (all.length) result.push("");
    if (shown.length < all.length) {
      result.push(truncateToWidth(this.theme.fg("muted", "… 已收起 " + (all.length - shown.length) + " 行 · ") +
        keyHint("app.tools.expand", "展开"), width));
    }
    result.push(...shown.map((line) => this.theme.fg("toolOutput", line)));
    if (this.footer) {
      result.push(...wrapTextWithAnsi(this.theme.fg("muted", this.footer), width));
    }
    return result;
  }
}

export const shellRenderers: Renderers = {
  renderCall(args, theme, context) {
    const input = args as Record<string, unknown>;
    const raw = typeof input.command === "string" ? displayText(input.command).trim() : "…";
    return {
      invalidate() {},
      render(width: number) {
        if (width <= 0) return [];
        const mark = statusMark(theme, context.isPartial, context.isError);
        // codex renders the `$ ` prompt in magenta and the command body highlighted.
        const heading = mark + " " + withRole(theme, "bashPrompt", "toolTitle", "$ ");
        if (context.expanded) return wrapTextWithAnsi(heading + highlightShell(raw), width);
        const lines = raw.split("\n");
        // Only the first line is shown collapsed; the line count is this
        // extension's own note, so it stays muted instead of taking the
        // colour of whatever token the first line happened to end on.
        const command = highlightShellLines(lines[0])[0] ?? "";
        const note = lines.length > 1 ? theme.fg("muted", ` …（${lines.length} 行命令）`) : "";
        return [truncateToWidth(heading + command + note, width)];
      },
    };
  },
  renderResult(result, options, theme, context) {
    let output = resultText(result);
    const fullOutputPath = result.details?.fullOutputPath;
    if (!options.isPartial && fullOutputPath && output.endsWith("]")) {
      const footer = output.lastIndexOf("\n\n[");
      if (footer !== -1 && output.slice(footer).includes(fullOutputPath)) output = output.slice(0, footer).trimEnd();
    }
    const footer: string[] = [];
    const elapsed = executionTimes.get(context.toolCallId);
    if (!options.isPartial && elapsed !== undefined) {
      footer.push("耗时 " + (elapsed / 1000).toFixed(1) + "s");
    }
    if (fullOutputPath) footer.push("完整输出: " + fullOutputPath);
    if (result.details?.truncation?.truncated && !fullOutputPath) footer.push("工具返回内容已达长度上限");
    return new CommandOutputComponent(output, options.expanded, theme, footer.join(" · ") || undefined);
  },
};

function fileHeader(verb: string): NonNullable<Renderers["renderCall"]> {
  return (args, theme, context) => ({
    invalidate() {},
    render(width: number) {
      if (width <= 0) return [];
      const input = args as Record<string, unknown>;
      const rawPath = displayText(String(input.path ?? input.file_path ?? "…"));
      const mark = statusMark(theme, context.isPartial, context.isError);
      return [truncateToWidth(mark + " " + theme.fg("toolTitle", verb) + " " + theme.fg("accent", rawPath), width)];
    },
  });
}

function fileResult(field: "diff" | "workflowDiff"): NonNullable<Renderers["renderResult"]> {
  return (result, options, theme, context) => {
    if (context.isError) return new CommandOutputComponent(resultText(result), options.expanded, theme);
    const diff = result.details?.[field];
    if (typeof diff === "string" && diff) return new DiffComponent(diff, options.expanded, theme);
    if (result.details?.workflowDiffOmitted) return new Text(theme.fg("muted", "文件较大，差异预览已省略。"), 0, 0);
    return new Text("", 0, 0);
  };
}

export const editRenderers: Renderers = { renderCall: fileHeader("修改"), renderResult: fileResult("diff") };
export const writeRenderers: Renderers = { renderCall: fileHeader("写入"), renderResult: fileResult("workflowDiff") };
