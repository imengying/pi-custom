import { homedir } from "node:os";
import { isAbsolute, relative, sep } from "node:path";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { stripCompactionNotices } from "./transcript.js";

// Nerd Fonts: Material Design database-outline, matching the cache indicator.
const CACHE_ICON = "\u{f1632}";

function formatTokens(count: number, precise = false): string {
  if (count < 1000) return String(Math.round(count));
  if (count < 1_000_000) {
    if (precise) return `${Number((count / 1000).toFixed(1))}k`;
    return count < 10_000 ? `${(count / 1000).toFixed(1)}k` : `${Math.round(count / 1000)}k`;
  }
  return count < 10_000_000 ? `${(count / 1_000_000).toFixed(1)}M` : `${Math.round(count / 1_000_000)}M`;
}

function sessionUsage(entries: SessionEntry[]) {
  let input = 0;
  let output = 0;
  let cacheHitRate: number | undefined;
  // Include earlier branches and compaction calls, as pi's native footer does.
  for (const entry of entries) {
    let usage;
    if (entry.type === "message" && entry.message.role === "assistant") {
      usage = entry.message.usage;
      const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
      cacheHitRate = promptTokens > 0 ? usage.cacheRead / promptTokens * 100 : undefined;
    } else if (entry.type === "message" && entry.message.role === "toolResult") {
      usage = entry.message.usage;
    } else if (entry.type === "branch_summary" || entry.type === "compaction") {
      usage = entry.usage;
    }
    if (usage) {
      input += usage.input;
      output += usage.output;
    }
  }
  return { input, output, cacheHitRate };
}

function singleLine(text: string): string {
  return stripTerminalSequences(text).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/ +/g, " ").trim();
}

function displayCwd(cwd: string): string {
  const path = relative(homedir(), cwd);
  return path === "" ? "~" :
    path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path) ? `~${sep}${path}` : cwd;
}

export function installCompactFooter(ctx: ExtensionContext): void {
  ctx.ui.setFooter((tui, _theme, footerData) => {
    const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
    return {
      dispose: unsubscribe,
      invalidate() {},
      render(width: number): string[] {
        if (width <= 0) return [];
        // The footer renders last in every frame, which is also when pi's startup
        // "Session compacted" notice can first exist. Sweep it before drawing, then
        // ask for one more frame so the transcript redraws without it: the chat part
        // of this frame has already been rendered by the time the footer runs.
        if (stripCompactionNotices(tui)) tui.requestRender();
        // Reload applies the selected theme after session_start; read it live.
        const theme = ctx.ui.theme;
        const { input, output, cacheHitRate } = sessionUsage(ctx.sessionManager.getEntries());
        const context = ctx.getContextUsage();
        const capacity = context?.contextWindow ?? ctx.model?.contextWindow;
        const used = context?.tokens == null ? "?" : formatTokens(context.tokens, true);
        const contextText = `${used}/${capacity ? formatTokens(capacity, true) : "?"}`;
        const percent = context?.percent ?? 0;
        const contextColor = percent > 90 ? "error" : percent > 70 ? "warning" : "muted";
        const fields = [
          theme.fg("muted", `↑ ${formatTokens(input)}`),
          theme.fg("muted", `↓ ${formatTokens(output)}`),
          theme.fg("muted", `${CACHE_ICON} ${cacheHitRate === undefined ? "—" : `${cacheHitRate.toFixed(1)}%`}`),
          theme.fg(contextColor, contextText),
        ];
        const left = truncateToWidth(fields.join("   "), width, "…");
        // Use the model ID directly; never prepend its provider, even with spare room.
        let model = singleLine(ctx.model?.id || "未选择模型");
        if (ctx.model?.reasoning) {
          const level = ctx.thinkingLevel || "off";
          model += ` • ${level === "off" ? "思考关闭" : level}`;
        }
        const available = width - visibleWidth(left) - 2;
        let statsLine = left;
        if (available > 0) {
          const right = truncateToWidth(theme.fg("muted", model), available, "…");
          statsLine += " ".repeat(width - visibleWidth(left) - visibleWidth(right)) + right;
        }

        let location = displayCwd(ctx.sessionManager.getCwd());
        const branch = footerData.getGitBranch();
        const name = ctx.sessionManager.getSessionName();
        if (branch) location += ` (${branch})`;
        if (name) location += ` • ${name}`;
        const lines = [truncateToWidth(theme.fg("dim", singleLine(location)), width, "…"), statsLine];
        const statuses = [...footerData.getExtensionStatuses()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([, status]) => status.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim())
          .filter(Boolean);
        if (statuses.length) lines.push(truncateToWidth(statuses.join(" "), width, "…"));
        return lines;
      },
    };
  });
}
