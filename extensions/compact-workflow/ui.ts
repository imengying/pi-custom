import type { ExtensionContext, MarkdownTransformContext, Theme } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, isKeyRepeat, matchesKey, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

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
  private allowSelected = true;
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
    this.title = reviewText(title);
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
    if (this.finished || data.includes("\x1b[200~") || isKeyRelease(data) || isKeyRepeat(data)) return;
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q") {
      this.finish(false);
      return;
    }
    if (matchesKey(data, "enter")) { this.finish(this.approval && this.allowSelected); return; }
    if (this.approval) {
      if (matchesKey(data, "a") || matchesKey(data, "1")) { this.finish(true); return; }
      if (matchesKey(data, "n") || matchesKey(data, "2")) { this.finish(false); return; }
      if (matchesKey(data, "up") || matchesKey(data, "down") || matchesKey(data, "tab")) {
        this.allowSelected = !this.allowSelected;
        this.redraw();
        return;
      }
    }
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
    if (this.approval) return this.renderApproval(width);
    const innerWidth = Math.max(1, width - 2);
    const content = wrapTextWithAnsi(this.body, innerWidth);
    this.pageSize = Math.max(1, Math.min(18, this.rows() - 5));
    this.maxOffset = Math.max(0, content.length - this.pageSize);
    this.offset = Math.min(this.offset, this.maxOffset);
    const body = content.slice(this.offset, this.offset + this.pageSize);
    const line = (text: string) => truncateToWidth(text, width);
    return [
      line(this.theme.fg("accent", this.theme.bold(this.title))),
      line(this.theme.fg("borderMuted", "─".repeat(width))),
      ...body.map((text) => line(" " + this.theme.fg("text", text))),
      line(this.theme.fg("muted", "↑↓ / PgUp PgDn 滚动 · " + (this.offset + 1) + "–" +
        Math.min(content.length, this.offset + this.pageSize) + " / " + content.length)),
      line(this.theme.fg("muted", "Enter/Esc 关闭")),
    ];
  }

  private renderApproval(width: number): string[] {
    const height = Math.max(1, Math.min(22, this.rows()));
    const innerWidth = Math.max(1, width - 4);
    const content = wrapTextWithAnsi(this.body, innerWidth);
    // Keep the title and choices visible even when the operation needs scrolling.
    const compact = height < 12;
    const overhead = compact ? 5 : 8;
    this.pageSize = Math.max(1, height - overhead);
    this.maxOffset = Math.max(0, content.length - this.pageSize);
    this.offset = Math.min(this.offset, this.maxOffset);
    const border = (left: string, right: string) => this.theme.fg("warning",
      width > 1 ? left + "─".repeat(width - 2) + right : "─");
    const row = (text: string, selected = false) => {
      const textWidth = Math.max(0, width - 4);
      const padded = padLine(truncateToWidth(text, textWidth), textWidth);
      return width >= 4
        ? this.theme.fg("warning", "│") + this.theme.bg(selected ? "selectedBg" : "userMessageBg", " " + padded + " ") + this.theme.fg("warning", "│")
        : truncateToWidth(text, width);
    };
    const choice = (allow: boolean) => {
      const selected = this.allowSelected === allow;
      return row(this.theme.fg(selected ? "accent" : "text",
        (selected ? "› " : "  ") + (allow ? "1. 允许本次操作" : "2. 拒绝并停止")), selected);
    };
    const position = (this.offset + 1) + "–" + Math.min(content.length, this.offset + this.pageSize) + "/" + content.length;
    const lines = height < 6 ? [
      ...(height >= 3 ? [row(this.theme.fg("warning", this.title))] : []),
      choice(true),
      choice(false),
      ...(height >= 4 ? [row(this.theme.fg("muted", "Enter 确认 · Esc 拒绝"))] : []),
    ] : [
      border("╭", "╮"),
      row(this.theme.fg("warning", this.theme.bold(this.title)) + (compact ? "" : this.theme.fg("muted", " · 等待确认，无超时"))),
      ...content.slice(this.offset, this.offset + this.pageSize).map((text) => row(this.theme.fg("text", text))),
      ...(compact ? [] : [row(this.theme.fg("muted", this.maxOffset > 0 ? "PgUp/PgDn 滚动 · " + position : "仅对本次操作有效"))]),
      ...(compact ? [] : [border("├", "┤")]),
      choice(true),
      choice(false),
      row(this.theme.fg("muted", width >= 64 ? "↑↓ 选择 · Enter 确认 · a 允许 · Esc 拒绝" : "Enter 确认 · Esc 拒绝")),
      ...(compact ? [] : [border("╰", "╯")]),
    ];
    // Paint every cell, including trailing whitespace, so chat never bleeds through.
    return lines.slice(0, height).map((line) => this.theme.bg("userMessageBg", padLine(truncateToWidth(line, width), width)));
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
  if (approval) ctx.ui.setWorkingMessage("等待用户授权");
  try {
    const result = await ctx.ui.custom<boolean>((tui, theme, _keys, done) =>
      new ReviewDialog(title, body, theme, approval, () => tui.terminal.rows,
        () => tui.requestRender(), done, signal),
    { overlay: true, overlayOptions: approval
      ? { width: "100%", anchor: "bottom-center" }
      : { width: "90%", anchor: "center" } });
    return result === true && !signal?.aborted;
  } finally {
    if (approval) ctx.ui.setWorkingMessage();
  }
}

export function padLine(line: string, width: number): string {
  return line + " ".repeat(Math.max(0, width - visibleWidth(line)));
}
