import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";

/**
 * The codex-dark theme gained two magenta accents (the `$` prompt and the git
 * branch) after this extension first shipped, following codex's own style guide
 * (`codex-rs/tui/styles.md`). An older copy of the theme does not define those
 * roles, and `Theme.fg` throws for an unknown role, so each optional role is
 * probed once per theme instance and the caller's fallback is used instead.
 */
const optionalRoles = new WeakMap<Theme, Set<string>>();
const PROBED_ROLES = ["bashPrompt", "branch"] as const;

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
