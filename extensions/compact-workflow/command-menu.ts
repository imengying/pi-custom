import type { AutocompleteItem, AutocompleteProvider } from "@earendil-works/pi-tui";

const HIDDEN_COMMANDS = new Set([
  "scoped-models", "import", "export", "share", "copy", "hotkeys", "fork",
  "clone", "trust", "llama", "login", "logout", "changelog", "thoughts", "tree",
  "permissions",
]);

const CHINESE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  settings: "打开设置菜单",
  model: "选择模型",
  thinking: "设置思考强度",
  name: "设置会话名称",
  session: "查看会话信息与用量统计",
  new: "开始新会话",
  compact: "压缩当前会话上下文",
  resume: "选择并继续历史会话",
  reload: "重新加载扩展、主题、技能和配置",
  quit: "退出 pi",
};

/** Customize only the slash-command menu through pi's public UI extension API. */
export function createChineseCommandMenu(current: AutocompleteProvider): AutocompleteProvider {
  const originals = new WeakMap<AutocompleteItem, AutocompleteItem>();
  return {
    triggerCharacters: current.triggerCharacters,
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const result = await current.getSuggestions(lines, cursorLine, cursorCol, options);
      if (options.signal.aborted) return null;
      const prefix = (lines[cursorLine] ?? "").slice(0, cursorCol);
      // Arguments, @attachments and forced path completion keep their own behavior.
      if (!result || options.force || !/^\/[^\s/]*$/.test(prefix) || result.prefix !== prefix) return result;
      const items: AutocompleteItem[] = [];
      for (const item of result.items) {
        const name = item.value.replace(/^\//, "");
        if (HIDDEN_COMMANDS.has(name)) continue;
        const description = Object.hasOwn(CHINESE_DESCRIPTIONS, name) ? CHINESE_DESCRIPTIONS[name] : undefined;
        if (description === undefined) {
          items.push(item);
          continue;
        }
        const translated = { ...item, description };
        originals.set(translated, item);
        items.push(translated);
      }
      return items.length ? { ...result, items } : null;
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      return current.applyCompletion(lines, cursorLine, cursorCol, originals.get(item) ?? item, prefix);
    },
    ...(current.shouldTriggerFileCompletion ? {
      shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number) {
        return current.shouldTriggerFileCompletion!(lines, cursorLine, cursorCol);
      },
    } : {}),
  };
}
