import type { ExtensionContext, MarkdownTransformContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export const THINKING_PREVIEW_LINES = 2;
export const COMMAND_PREVIEW_LINES = 5;
export const DIFF_PREVIEW_LINES = 14;

/** Keep terminal controls and bidi controls visible in a security review. */
export function reviewText(text: string): string {
  return text.replace(/\t/g, "    ").replace(
    /[\x00-\x08\x0b-\x1f\x7f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
    (char) => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}

export function displayText(text: string): string {
  return reviewText(stripTerminalSequences(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n"));
}

function escapeMarkdown(text: string): string {
  return text.replace(/[\\*_{}\[\]<>#+.!|~-]/g, "\\$&")
    .replaceAll(String.fromCharCode(96), "\\" + String.fromCharCode(96));
}

/** A display-only transform. Original thinking stays intact in the session. */
export function compactThinking(markdown: string, context: MarkdownTransformContext): string {
  if (context.messageType !== "assistant-thinking") return markdown;
  if (!context.isStreaming) return "思考完成";
  const width = Math.max(8, context.availableWidth);
  // Only normalize a bounded suffix, even when the full thinking block is huge.
  const suffix = markdown.slice(-Math.max(512, width * THINKING_PREVIEW_LINES * 4));
  const plain = displayText(suffix).replace(/\s+/g, " ").trim();
  const lines = wrapTextWithAnsi(plain, width).slice(-THINKING_PREVIEW_LINES);
  return "思考中\n\n" + lines.map(escapeMarkdown).join("  \n");
}

/** Scrollable plain-text review, with no terminal escapes supplied by content. */
export class ReviewDialog {
  private offset = 0;
  private maxOffset = 0;
  private pageSize = 1;
  private finished = false;
  private abortListener: (() => void) | undefined;

  constructor(
    private title: string,
    private body: string,
    private theme: Theme,
    private approval: boolean,
    private rows: () => number,
    private redraw: () => void,
    private done: (approved: boolean) => void,
    private signal?: AbortSignal,
  ) {
    this.body = reviewText(body);
    this.abortListener = () => this.finish(false);
    if (signal?.aborted) this.finish(false);
    else signal?.addEventListener("abort", this.abortListener, { once: true });
  }

  private finish(approved: boolean): void {
    if (this.finished) return;
    this.finished = true;
    this.dispose();
    this.done(approved && !this.signal?.aborted);
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "enter") || data === "q") {
      this.finish(false);
      return;
    }
    // Enter never grants permission. Approval requires an explicit single key.
    if (this.approval && matchesKey(data, "a")) { this.finish(true); return; }
    if (matchesKey(data, "up") || data === "k") this.offset--;
    else if (matchesKey(data, "down") || data === "j") this.offset++;
    else if (matchesKey(data, "pageUp")) this.offset -= this.pageSize;
    else if (matchesKey(data, "pageDown") || data === " ") this.offset += this.pageSize;
    else if (matchesKey(data, "home")) this.offset = 0;
    else if (matchesKey(data, "end")) this.offset = this.maxOffset;
    this.offset = Math.max(0, Math.min(this.maxOffset, this.offset));
    this.redraw();
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    const innerWidth = Math.max(1, width - 2);
    const content = wrapTextWithAnsi(this.body, innerWidth);
    this.pageSize = Math.max(1, Math.min(18, this.rows() - 5));
    this.maxOffset = Math.max(0, content.length - this.pageSize);
    this.offset = Math.min(this.offset, this.maxOffset);
    const body = content.slice(this.offset, this.offset + this.pageSize);
    const line = (text: string) => truncateToWidth(text, width);
    const controls = this.approval ? "a 仅本次允许 · Enter/Esc 拒绝" : "Enter/Esc 关闭";
    return [
      line(this.theme.fg(this.approval ? "warning" : "accent", this.theme.bold(this.title))),
      line(this.theme.fg("borderMuted", "─".repeat(width))),
      ...body.map((text) => line(" " + this.theme.fg("text", text))),
      line(this.theme.fg("muted", "↑↓ / PgUp PgDn 滚动 · " + (this.offset + 1) + "–" +
        Math.min(content.length, this.offset + this.pageSize) + " / " + content.length)),
      line(this.theme.fg(this.approval ? "warning" : "muted", controls)),
    ];
  }

  invalidate(): void {}
  dispose(): void {
    if (this.abortListener) this.signal?.removeEventListener("abort", this.abortListener);
    this.abortListener = undefined;
  }
}

export async function showReview(
  ctx: ExtensionContext,
  title: string,
  body: string,
  approval = false,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!ctx.hasUI || signal?.aborted) return false;
  const result = await ctx.ui.custom<boolean>((tui, theme, _keys, done) =>
    new ReviewDialog(title, body, theme, approval, () => tui.terminal.rows,
      () => tui.requestRender(), done, signal),
  { overlay: true, overlayOptions: { width: "90%", anchor: "center" } });
  return result === true && !signal?.aborted;
}

export function padLine(line: string, width: number): string {
  return line + " ".repeat(Math.max(0, width - visibleWidth(line)));
}
