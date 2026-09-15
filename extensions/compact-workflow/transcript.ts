/**
 * Removes pi's startup `Session compacted N times` notice from the transcript.
 *
 * pi writes that line from `renderInitialMessages()` whenever the session holds a
 * compaction entry, and it comes back on every resume, fork, or tree navigation.
 * No setting or extension hook controls it, and the transcript already shows the
 * compaction summary itself, so the line is dropped here instead.
 *
 * `renderInitialMessages()` runs after `session_start` returns, so the notice does
 * not exist yet when the extension is first given the TUI. It is therefore removed
 * from pi's chat container while the footer renders, which happens at the end of
 * each frame; the sweep is idempotent and only matches an exact status line, so a
 * caller can simply run it on every frame.
 *
 * Every field is read defensively: pi's TUI internals are not part of the public
 * extension API, so a shape change must degrade to "the line stays visible" rather
 * than throw or delete something else.
 */

import { stripTerminalSequences } from "@earendil-works/pi-tui";

/**
 * pi's exact wording, tolerating the dim styling it applies. `times` is `1 time`
 * or `N times`, so a message that merely mentions the phrase does not match.
 */
const STATUS_PATTERN = /^\s*Session compacted (?:1 time|\d+ times)\s*$/;

/**
 * The notice is a leaf `Text` component holding a plain string. The class name is
 * checked rather than only the shape, because an assistant message whose whole body
 * reads "Session compacted 2 times" is also a leaf carrying `text`; pi renders that
 * body with `Markdown`, so the marker is what separates real content from chrome.
 * `constructor.name` is used instead of `instanceof`, which does not survive the
 * module duplication introduced by pi's extension loader.
 */
function isStatusLine(component: unknown): boolean {
  if (!component || typeof component !== "object") return false;
  const candidate = component as { text?: unknown; render?: unknown; children?: unknown; constructor?: { name?: string } };
  if (candidate.constructor?.name !== "Text") return false;
  if (typeof candidate.text !== "string" || typeof candidate.render !== "function") return false;
  if (Array.isArray(candidate.children)) return false;
  return STATUS_PATTERN.test(stripTerminalSequences(candidate.text));
}

/** The blank line `showStatus` inserts directly above its notice. */
function isSpacer(component: unknown): boolean {
  if (!component || typeof component !== "object") return false;
  const candidate = component as { lines?: unknown; text?: unknown; constructor?: { name?: string } };
  return candidate.constructor?.name === "Spacer" && typeof candidate.lines === "number";
}

/**
 * Delete every status notice found in a component tree, together with the blank
 * line each one introduced. Returns how many notices were removed.
 *
 * A notice is only recognised as the `Spacer` + `Text` pair that `showStatus`
 * appends. Requiring the pair is what keeps this from matching a user message that
 * happens to spell out the same words, which would silently delete real content.
 */
export function stripCompactionNotices(root: unknown): number {
  if (!root || typeof root !== "object") return 0;
  let removed = 0;
  const stack: unknown[] = [root];
  // Bounded so a pathological or cyclic tree cannot spin here.
  for (let visited = 0; stack.length && visited < 5000; visited++) {
    const children = (stack.pop() as { children?: unknown }).children;
    if (!Array.isArray(children)) continue;
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i];
      if (i > 0 && isSpacer(children[i - 1]) && isStatusLine(child)) {
        children.splice(i - 1, 2);
        removed++;
      } else if (child && typeof child === "object") {
        stack.push(child);
      }
    }
  }
  return removed;
}
