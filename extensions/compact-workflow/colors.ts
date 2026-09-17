import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";

/**
 * The codex-dark theme defines two magenta accents (the `$` prompt and the git branch)
 * following codex's own style guide (`codex-rs/tui/styles.md`). They are not in pi's
 * `ThemeColor` union, and pi's own themes (`dark`, `light`) do not define them, while
 * `Theme.fg` throws on an unknown role. A user who switches away from codex-dark would
 * therefore crash the renderer mid-session, so each role is probed once per theme
 * instance and the caller's fallback colour is used when it is missing.
 */
const PROBED_ROLES = ["bashPrompt", "branch"] as const;
const optionalRoles = new WeakMap<Theme, Set<string>>();

function definedRoles(theme: Theme): Set<string> {
  const cached = optionalRoles.get(theme);
  if (cached) return cached;
  const defined = new Set<string>();
  for (const role of PROBED_ROLES) {
    try {
      theme.fg(role as ThemeColor, "x");
      defined.add(role);
    } catch {
      // Not defined by this theme; `withRole` falls back.
    }
  }
  optionalRoles.set(theme, defined);
  return defined;
}

/** Color `text` with `role` when the theme defines it, otherwise with `fallback`. */
export function withRole(theme: Theme, role: string, fallback: ThemeColor, text: string): string {
  return definedRoles(theme).has(role) ? theme.fg(role as ThemeColor, text) : theme.fg(fallback, text);
}
