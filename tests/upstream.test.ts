import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { BUILTIN_SLASH_COMMANDS } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/slash-commands.js";
import { loadThemeFromPath } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";

/**
 * pi does not re-export two things the tests need through its public entry point:
 *
 *   - `dist/core/slash-commands.js`, the built-in command list the menu filters,
 *   - `dist/modes/interactive/theme/theme.js`, for loading theme JSON in tests.
 *
 * Those `dist/` paths are not public API, so an upgrade can move them and the failure
 * would surface as a puzzling "cannot find module" inside an unrelated test file. This
 * test names the dependency once, so a rename fails here with the path to fix.
 */
test("upstream internals the tests rely on still exist", () => {
  expect(Array.isArray(BUILTIN_SLASH_COMMANDS)).toBe(true);
  expect(BUILTIN_SLASH_COMMANDS.length).toBeGreaterThan(0);
  for (const command of BUILTIN_SLASH_COMMANDS) {
    expect(typeof command.name).toBe("string");
    expect(typeof command.description).toBe("string");
  }
  expect(typeof loadThemeFromPath).toBe("function");
});

test("the shipped theme defines both roles it accents", () => {
  // `withRole` falls back at runtime, so losing either role would silently drop the
  // magenta accents rather than fail; this is what keeps the theme honest.
  const theme = loadThemeFromPath(fileURLToPath(new URL("../themes/codex-dark.json", import.meta.url)), "truecolor");
  for (const role of ["bashPrompt", "branch"]) {
    expect(() => theme.fg(role as never, "x")).not.toThrow();
  }
});
