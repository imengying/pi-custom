import { describe, expect, test } from "bun:test";
import {
  CombinedAutocompleteProvider,
  type AutocompleteItem,
  type AutocompleteProvider,
  type SlashCommand,
} from "@earendil-works/pi-tui";
import { BUILTIN_SLASH_COMMANDS } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/slash-commands.js";
import { createChineseCommandMenu } from "../extensions/compact-workflow/command-menu.js";

const hidden = [
  "scoped-models", "import", "export", "share", "copy", "hotkeys", "fork",
  "clone", "trust", "llama", "login", "logout", "changelog", "thoughts", "tree",
];
const options = () => ({ signal: new AbortController().signal });
const commands: SlashCommand[] = [
  ...BUILTIN_SLASH_COMMANDS,
  { name: "llama", description: "Manage llama.cpp models" },
  { name: "thoughts", description: "[local] 查看最近一次完整思考" },
  { name: "permissions", description: "[local] 查看高危操作授权规则" },
];
const native = () => new CombinedAutocompleteProvider(commands, process.cwd());

describe("Chinese slash-command menu", () => {
  test("all requested command entries disappear from the root menu", async () => {
    const provider = createChineseCommandMenu(native());
    const result = await provider.getSuggestions(["/"], 0, 1, options());
    expect(result).not.toBeNull();
    const names = result!.items.map((item) => item.value);
    for (const name of hidden) expect(names).not.toContain(name);
    expect(names).toEqual([
      "settings", "model", "thinking", "name", "session", "new",
      "compact", "resume", "reload", "quit", "permissions",
    ]);
    for (const item of result!.items) {
      expect(item.description).toMatch(/[\u4e00-\u9fff]/);
      expect(item.description).not.toContain("[local]");
    }
  });

  for (const name of hidden) {
    test("exact lookup cannot reintroduce /" + name, async () => {
      const provider = createChineseCommandMenu(native());
      const line = "/" + name;
      const result = await provider.getSuggestions([line], 0, line.length, options());
      expect(result?.items.some((item) => item.value === name) ?? false).toBe(false);
    });
  }

  test("English argument hints in command descriptions are translated too", async () => {
    const result = await createChineseCommandMenu(native()).getSuggestions(["/"], 0, 1, options());
    expect(result!.items.find((item) => item.value === "model")!.description).toBe("<提供方/模型> — 选择模型");
    expect(result!.items.find((item) => item.value === "thinking")!.description).toBe("<级别> — 设置思考强度");
  });

  test("native command completion still inserts the original command name", async () => {
    const provider = createChineseCommandMenu(native());
    const result = await provider.getSuggestions(["/mod"], 0, 4, options());
    const item = result!.items.find((item) => item.value === "model")!;
    expect(item.label).toBe("model");
    expect(provider.applyCompletion(["/mod"], 0, 4, item, result!.prefix)).toEqual({
      lines: ["/model "], cursorLine: 0, cursorCol: 7,
    });
  });

  test("model and thinking argument completions keep their original values and descriptions", async () => {
    const modelItems = [{ value: "llama", label: "llama", description: "Local provider" }];
    const thinkingItems = [{ value: "high", label: "high", description: "Model reasoning level" }];
    const provider = createChineseCommandMenu(new CombinedAutocompleteProvider([
      { name: "model", getArgumentCompletions: () => modelItems },
      { name: "thinking", getArgumentCompletions: () => thinkingItems },
    ], process.cwd()));
    expect((await provider.getSuggestions(["/model "], 0, 7, options()))!.items).toBe(modelItems);
    expect((await provider.getSuggestions(["/thinking "], 0, 10, options()))!.items).toBe(thinkingItems);
  });

  test("unknown future commands retain their own description", async () => {
    const provider = createChineseCommandMenu(new CombinedAutocompleteProvider([
      { name: "future-command", description: "New functionality" },
      { name: "constructor", description: "Custom command" },
    ], process.cwd()));
    const result = await provider.getSuggestions(["/"], 0, 1, options());
    expect(result!.items[0].description).toBe("New functionality");
    expect(result!.items[1].description).toBe("Custom command");
  });

  test("stacking after a reload remains idempotent", async () => {
    const single = createChineseCommandMenu(native());
    const twice = createChineseCommandMenu(single);
    expect(await twice.getSuggestions(["/"], 0, 1, options())).toEqual(
      await single.getSuggestions(["/"], 0, 1, options()),
    );
    const result = await twice.getSuggestions(["/set"], 0, 4, options());
    const item = result!.items.find((item) => item.value === "settings")!;
    expect(twice.applyCompletion(["/set"], 0, 4, item, result!.prefix).lines).toEqual(["/settings "]);
  });
});

describe("delegation to the existing provider", () => {
  function stub(item: AutocompleteItem, prefix: string): AutocompleteProvider {
    return {
      triggerCharacters: ["#"],
      async getSuggestions() { return { items: [item], prefix }; },
      applyCompletion(lines, cursorLine, cursorCol, selected) {
        expect(selected).toBe(item);
        return { lines, cursorLine, cursorCol };
      },
      shouldTriggerFileCompletion() { return false; },
    };
  }

  test("forced path completion does not hide a path named copy", async () => {
    const item = { value: "copy", label: "copy", description: "File" };
    const provider = createChineseCommandMenu(stub(item, "/c"));
    const result = await provider.getSuggestions(["/c"], 0, 2, { ...options(), force: true });
    expect(result!.items).toEqual([item]);
    expect(result!.items[0]).toBe(item);
  });

  test("@file attachments and ordinary path completions pass through", async () => {
    for (const prefix of ["@copy", "./copy", "/tmp/copy"]) {
      const item = { value: "copy", label: "copy", description: "File" };
      const provider = createChineseCommandMenu(stub(item, prefix));
      expect((await provider.getSuggestions([prefix], 0, prefix.length, options()))!.items[0]).toBe(item);
    }
  });

  test("source items are never mutated and original item identity is restored when applying", async () => {
    const item = Object.freeze({ value: "model", label: "model", description: "Select model" });
    const provider = createChineseCommandMenu(stub(item, "/m"));
    const translated = (await provider.getSuggestions(["/m"], 0, 2, options()))!.items[0];
    expect(translated.description).toContain("选择模型");
    expect(item.description).toBe("Select model");
    provider.applyCompletion(["/m"], 0, 2, translated, "/m");
    expect(provider.triggerCharacters).toEqual(["#"]);
    expect(provider.shouldTriggerFileCompletion!(["/m"], 0, 2)).toBe(false);
  });

  test("an aborted completion cannot show stale suggestions", async () => {
    const controller = new AbortController();
    const provider = createChineseCommandMenu(stub({ value: "model", label: "model" }, "/m"));
    controller.abort();
    expect(await provider.getSuggestions(["/m"], 0, 2, { signal: controller.signal })).toBeNull();
  });
});
