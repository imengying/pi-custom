import { describe, expect, test } from "bun:test";
import { AssistantMessageComponent, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { stripCompactionNotices } from "../extensions/compact-workflow/transcript.js";

const dim = (text: string) => "\x1b[38;2;102;102;102m" + text + "\x1b[39m";

/** Mirrors what pi's showStatus() appends: a spacer followed by a dim Text line. */
function piStatus(container: Container, message: string): Text {
  container.addChild(new Spacer(1));
  const text = new Text(dim(message), 1, 0);
  container.addChild(text);
  return text;
}

describe("compaction notice removal", () => {
  test("removes the notice and the blank line it introduced", () => {
    const chat = new Container();
    chat.addChild(new Text("existing message", 1, 0));
    piStatus(chat, "Session compacted 2 times");
    chat.addChild(new Text("later output", 1, 0));
    const before = chat.children.length;
    expect(stripCompactionNotices(chat)).toBe(1);
    expect(chat.children.length).toBe(before - 2);
    expect(chat.children.map((child) => (child as any).text)).toEqual(["existing message", "later output"]);
  });

  test("handles both plural forms and repeated notices", () => {
    const chat = new Container();
    piStatus(chat, "Session compacted 1 time");
    piStatus(chat, "Session compacted 7 times");
    expect(stripCompactionNotices(chat)).toBe(2);
    expect(chat.children).toHaveLength(0);
  });

  test("finds notices nested deeper in the tree", () => {
    const chat = new Container();
    const inner = new Container();
    piStatus(inner, "Session compacted 3 times");
    chat.addChild(inner);
    chat.addChild(new Text("keep", 1, 0));
    expect(stripCompactionNotices(chat)).toBe(1);
    expect(inner.children).toHaveLength(0);
    expect(chat.children).toHaveLength(2);
    expect((chat.children[1] as any).text).toBe("keep");
  });

  test("never removes anything else", () => {
    const keep = [
      "Session compacted",                  // no count
      "Session compacted many times",        // not pi's wording
      "I saw Session compacted 2 times",     // mentions the phrase mid-sentence
      "Session compacted 2 times in total",  // extra words
      "session compacted 2 times",           // wrong case
    ];
    const chat = new Container();
    for (const text of keep) chat.addChild(new Text(text, 1, 0));
    expect(stripCompactionNotices(chat)).toBe(0);
    expect(chat.children).toHaveLength(keep.length);
  });

  test("a bare Text is not removed without the spacer showStatus pairs it with", () => {
    // Recognising the Spacer+Text pair is what keeps this from matching a message
    // that merely spells out the same words, which would delete real content.
    const chat = new Container();
    chat.addChild(new Text("Session compacted 2 times", 1, 0));
    expect(stripCompactionNotices(chat)).toBe(0);
    expect(chat.children).toHaveLength(1);
  });

  test("a message whose whole body is that text is never deleted", () => {
    // A one-line assistant reply reading exactly "Session compacted 2 times" is shaped
    // like the notice (leaf, `text` field, right after a spacer). pi renders a message
    // body with Markdown, so the `Text` marker is what protects real content here.
    const chat = new Container();
    chat.addChild(new Spacer(1));
    chat.addChild(new Markdown("Session compacted 2 times", 0, 0));
    expect(stripCompactionNotices(chat)).toBe(0);
    expect(chat.children).toHaveLength(2);
    // The full message component keeps its body as well.
    const message = new AssistantMessageComponent({
      role: "assistant", stopReason: "stop",
      content: [{ type: "text", text: "Session compacted 2 times" }],
    } as any, false, getMarkdownTheme());
    const chat2 = new Container();
    chat2.addChild(new Spacer(1));
    chat2.addChild(message);
    expect(stripCompactionNotices(chat2)).toBe(0);
    expect(chat2.children).toHaveLength(2);
  });

  test("a container that only mentions the phrase keeps its content", () => {
    // User messages are containers and also carry a `text` field, so a nesting check
    // alone must not treat them as the notice.
    const message = new Container();
    message.addChild(new Text("Session compacted 2 times", 0, 0));
    (message as any).text = "Session compacted 2 times";
    const chat = new Container();
    chat.addChild(message);
    expect(stripCompactionNotices(chat)).toBe(0);
    expect(chat.children).toHaveLength(1);
    expect(message.children).toHaveLength(1);
  });

  test("is idempotent and safe on unexpected input", () => {
    const chat = new Container();
    piStatus(chat, "Session compacted 1 time");
    expect(stripCompactionNotices(chat)).toBe(1);
    expect(stripCompactionNotices(chat)).toBe(0);
    for (const input of [undefined, null, 42, "text", {}, { children: "no" }, { children: [] }]) {
      expect(stripCompactionNotices(input)).toBe(0);
    }
  });

  test("a cyclic tree cannot loop forever", () => {
    const a = new Container();
    const b = new Container();
    a.addChild(b);
    b.addChild(a);
    const finished = stripCompactionNotices(a);
    expect(typeof finished).toBe("number");
  });

  test("keeps a spacer that does not belong to the notice", () => {
    const chat = new Container();
    chat.addChild(new Spacer(1));
    chat.addChild(new Text("unrelated", 1, 0));
    piStatus(chat, "Session compacted 1 time");
    expect(stripCompactionNotices(chat)).toBe(1);
    // The leading spacer and the unrelated line are untouched.
    expect(chat.children).toHaveLength(2);
    expect((chat.children[1] as any).text).toBe("unrelated");
  });
});
