import { homedir } from "node:os";
import { isAbsolute, relative, sep } from "node:path";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { withRole } from "./colors.js";

// Nerd Fonts: Material Design database-outline, matching the cache indicator.
const CACHE_ICON = "\u{f1632}";

/**
 * Scale a token count down to `k` / `M` with one decimal place.
 *
 * Trailing `.0` is dropped, so a whole value reads as `256k` or `1M` instead of
 * `256.0k` / `1.0M` — the decimal only ever carries real information.
 */
function scaled(count: number, divisor: number, suffix: string): string {
  const text = (count / divisor).toFixed(1);
  return (text.endsWith(".0") ? text.slice(0, -2) : text) + suffix;
}

function formatTokens(count: number, precise = false): string {
  if (count < 1000) return String(Math.round(count));
  if (count < 1_000_000) {
    if (precise) return scaled(count, 1000, "k");
    return count < 10_000 ? scaled(count, 1000, "k") : `${Math.round(count / 1000)}k`;
  }
  return count < 10_000_000 ? scaled(count, 1_000_000, "M") : `${Math.round(count / 1_000_000)}M`;
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
        // Reload applies the selected theme after session_start; read it live.
        const theme = ctx.ui.theme;
        const { input, output, cacheHitRate } = sessionUsage(ctx.sessionManager.getEntries());
        const context = ctx.getContextUsage();
        const capacity = context?.contextWindow ?? ctx.model?.contextWindow;
        const used = context?.tokens == null ? "?" : formatTokens(context.tokens, true);
        const contextText = `${used}/${capacity ? formatTokens(capacity, true) : "?"}`;
        const percent = context?.percent ?? 0;
        const contextColor = percent > 90 ? "error" : percent > 70 ? "warning" : "muted";
        // codex gives each status-line item its own accent (model cyan, path
        // green, branch magenta, usage green) instead of one flat grey.
        const fields = [
          theme.fg("success", `↑ ${formatTokens(input)}`),
          theme.fg("success", `↓ ${formatTokens(output)}`),
          theme.fg("success", `${CACHE_ICON} ${cacheHitRate === undefined ? "—" : `${cacheHitRate.toFixed(1)}%`}`),
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
          // The model name is the status line's cyan item in codex's accent map.
          const right = truncateToWidth(theme.fg("accent", model), available, "…");
          statsLine += " ".repeat(width - visibleWidth(left) - visibleWidth(right)) + right;
        }

        const location = displayCwd(ctx.sessionManager.getCwd());
        const branch = footerData.getGitBranch();
        const name = ctx.sessionManager.getSessionName();
        // Path is codex's green item and the git branch its magenta one, so keep
        // the two separately coloured instead of dimming the whole line.
        let locationLine = theme.fg("success", singleLine(location));
        if (branch) locationLine += theme.fg("dim", " (") + withRole(theme, "branch", "dim", singleLine(branch)) + theme.fg("dim", ")");
        if (name) locationLine += theme.fg("dim", " • ") + theme.fg("muted", singleLine(name));
        const lines = [truncateToWidth(locationLine, width, "…"), statsLine];
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
