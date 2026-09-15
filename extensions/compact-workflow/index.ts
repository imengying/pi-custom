import { readFile, stat, writeFile, mkdir } from "node:fs/promises";
import {
  createBashToolDefinition, createEditToolDefinition, createWriteToolDefinition,
  createLocalBashOperations, generateDiffString, SettingsManager,
  type ExtensionAPI, type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { PermissionGate } from "./guard.js";
import { currentShellDialect, currentShellPath, dialectForShellPath, setShellDialect } from "./policy.js";
import { shellRenderers, editRenderers, writeRenderers } from "./renderers.js";
import { compactThinking, showReview } from "./ui.js";
import { createChineseCommandMenu } from "./command-menu.js";
import { installCompactFooter } from "./compact-footer.js";

const MAX_DIFF_BYTES = 128 * 1024;
const MAX_DIFF_LINES = 2000;

type ShellConfig = { shellPath?: string; commandPrefix?: string };

const shellConfigs = new Map<string, ShellConfig>();

/**
 * pi only honours an explicit `shellPath` and otherwise hardcodes bash on Unix, so
 * `$SHELL` is not consulted. A user who wants zsh therefore has to say so in
 * settings; this mirror detects that case and switches both the spawn and the
 * policy dialect with it. Detection is best-effort and never blocks the tool.
 */
function detectShellDialect(config: ShellConfig): void {
  setShellDialect(dialectForShellPath(config.shellPath), config.shellPath);
}

/**
 * pi resolves `shellPath` and `shellCommandPrefix` through SettingsManager before
 * building the built-in bash tool. Overriding that tool replaces those defaults, so
 * reuse the same public reader here; otherwise a custom shell or a command prefix
 * silently stops applying. Reading takes a settings lock, so the result is cached
 * per directory and dropped on session start, which is also when reload re-reads it.
 * Failures keep pi's defaults rather than breaking bash.
 */
function shellConfig(cwd: string): ShellConfig {
  const cached = shellConfigs.get(cwd);
  if (cached) return cached;
  let config: ShellConfig = {};
  try {
    const settings = SettingsManager.create(cwd);
    config = {
      shellPath: settings.getShellPath() || undefined,
      commandPrefix: settings.getShellCommandPrefix() || undefined,
    };
  } catch { /* pi's defaults stay in effect. */ }
  detectShellDialect(config);
  shellConfigs.set(cwd, config);
  return config;
}

function thinkingFromMessage(message: any): string {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content.filter((part: any) => part.type === "thinking" && typeof part.thinking === "string")
    .map((part: any) => part.thinking).join("\n\n");
}

function restoredThinking(ctx: ExtensionContext): string {
  const entries = ctx.sessionManager.getBranch();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "message") continue;
    const thinking = thinkingFromMessage(entry.message);
    if (thinking) return thinking;
  }
  return "";
}

async function readBeforeWrite(path: string): Promise<string | undefined> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_DIFF_BYTES) return undefined;
    return await readFile(path, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "" : undefined;
  }
}

export default function compactWorkflow(pi: ExtensionAPI): void {
  const gate = new PermissionGate();
  let latestThinking = "";

  pi.registerMarkdownTransformer(compactThinking);

  pi.on("session_start", (_event, ctx) => {
    gate.reset();
    shellConfigs.clear();
    // Resolve the shell before the first command so the policy dialect is settled.
    shellConfig(ctx.cwd);
    latestThinking = restoredThinking(ctx);
    if (!ctx.hasUI) return;
    ctx.ui.addAutocompleteProvider(createChineseCommandMenu);
    ctx.ui.setToolsExpanded(false);
    ctx.ui.setHiddenThinkingLabel("思考已折叠");
    ctx.ui.setStatus("compact-workflow", undefined);
    if (ctx.mode === "tui") installCompactFooter(ctx);
  });
  pi.on("agent_start", (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setToolsExpanded(false);
  });
  pi.on("message_update", (event) => {
    const thinking = thinkingFromMessage(event.message);
    if (thinking) latestThinking = thinking;
  });
  pi.on("message_end", (event) => {
    const thinking = thinkingFromMessage(event.message);
    if (thinking) latestThinking = thinking;
  });
  pi.on("session_shutdown", (_event, ctx) => {
    gate.reset();
    if (ctx.hasUI) ctx.ui.setStatus("compact-workflow", undefined);
  });

  pi.registerCommand("thoughts", {
    description: "只读查看最近一次完整思考，不展开聊天记录",
    handler: async (_args, ctx) => {
      await showReview(ctx, "最近一次思考 · 只读", latestThinking || restoredThinking(ctx) || "当前会话尚无思考内容。");
    },
  });
  pi.registerCommand("permissions", {
    description: "查看高危操作授权规则",
    handler: async (_args, ctx) => {
      await showReview(ctx, "当前权限规则",
        "自动执行\n" +
        "  简单只读命令（ls、cat、grep、git status、sed -n '1p' 等）\n" +
        "  当前目录内普通文件的 edit / write\n\n" +
        "需要授权\n" +
        "  删除、提权、Git 写操作、网络传输、脚本、重定向、变量或命令替换\n" +
        "  未知选项、自定义工具、目录外或受保护路径的写入\n" +
        "  凭据与敏感配置：.env*、.ssh、.gnupg、.aws、.kube、.netrc、.npmrc、\n" +
        "    .git-credentials、~/.config/gh、~/.docker 等，以及 id_rsa、*.pem 等名称\n\n" +
        "授权面板\n" +
        "  ↑↓ / Tab 选择，Enter 确认；a / 1 允许本次，Esc / 2 / n 拒绝\n" +
        "  PgUp/PgDn、j/k、Home/End 滚动；等待确认没有超时\n" +
        "  授权只对当次操作有效，没有永久放行前缀\n\n" +
        "shell：" + (currentShellDialect() === "zsh"
          ? (currentShellPath() ?? "zsh") + "（=命令 展开需授权）"
          : "bash（pi 默认；shellPath 设为 /usr/bin/zsh 可切换）") +
        "\n工作目录：" + ctx.cwd + "\n" +
        "系统级沙箱未由此扩展启用，不能作为不可信代码的隔离边界。");
    },
  });

  pi.on("tool_call", (event, ctx) => {
    // Resolve the shell before assessing: the policy dialect must match the shell
    // that will run the command, and this hook is where approval is granted.
    shellConfig(ctx.cwd);
    return gate.preflight(event.toolCallId, event.toolName, event.input as Record<string, unknown>, ctx);
  });
  pi.on("tool_execution_end", (event) => gate.finish(event.toolCallId));

  pi.on("user_bash", async (event, ctx) => {
    shellConfig(event.cwd);
    const userContext = { ...ctx, cwd: event.cwd };
    if (!await gate.userCommand(event.command, userContext)) {
      return { result: { output: "命令已取消：未获得用户授权。", exitCode: 126, cancelled: true, truncated: false } };
    }
    const local = createLocalBashOperations(shellConfig(event.cwd));
    return {
      operations: {
        async exec(command, cwd, options) {
          // A prefix or another hook may have changed the actual command, so the
          // approval is re-checked here instead of reusing the earlier decision.
          const decision = await gate.userCommand(command, { ...ctx, cwd, signal: options.signal ?? ctx.signal });
          if (!decision || options.signal?.aborted) throw new Error("命令已取消：未获得用户授权。");
          return local.exec(decision.safeCommand ?? command, cwd, options);
        },
      },
    };
  });

  // Constructed with the session cwd only so the definition is complete; every
  // execute() below rebuilds it with ctx.cwd and the user's shell settings.
  const bash = createBashToolDefinition(process.cwd());
  pi.registerTool({
    ...bash,
    ...shellRenderers,
    renderShell: "default",
    async execute(id, args, signal, onUpdate, ctx) {
      // Defensive: the dialect must be settled before beforeExecute assesses args.
      const config = shellConfig(ctx.cwd);
      const decision = await gate.beforeExecute(id, "bash", args, ctx);
      return createBashToolDefinition(ctx.cwd, config).execute(
        id, { ...args, command: decision.safeCommand ?? args.command }, signal, onUpdate, ctx,
      );
    },
  });

  const edit = createEditToolDefinition(process.cwd());
  pi.registerTool({
    ...edit,
    ...editRenderers,
    renderShell: "default",
    async execute(id, args, signal, onUpdate, ctx) {
      await gate.beforeExecute(id, "edit", args, ctx);
      return createEditToolDefinition(ctx.cwd).execute(id, args, signal, onUpdate, ctx);
    },
  });

  const write = createWriteToolDefinition(process.cwd());
  pi.registerTool<typeof write.parameters, { workflowDiff?: string; workflowDiffOmitted?: boolean } | undefined>({
    ...write,
    ...writeRenderers,
    renderShell: "default",
    async execute(id, args, signal, onUpdate, ctx) {
      await gate.beforeExecute(id, "write", args, ctx);
      let before: string | undefined;
      const native = createWriteToolDefinition(ctx.cwd, {
        operations: {
          mkdir: async (path) => { await mkdir(path, { recursive: true }); },
          writeFile: async (path, content) => {
            // Called inside pi's existing file mutation queue.
            before = await readBeforeWrite(path);
            if (signal?.aborted) throw new Error("操作已取消");
            await writeFile(path, content, "utf8");
          },
        },
      });
      const result = await native.execute(id, args, signal, onUpdate, ctx);
      const canDiff = before !== undefined &&
        Buffer.byteLength(before) + Buffer.byteLength(args.content) <= MAX_DIFF_BYTES &&
        before.split("\n").length + args.content.split("\n").length <= MAX_DIFF_LINES;
      // Only presentation details are added. The original tool text is preserved.
      return {
        ...result,
        details: canDiff ? { workflowDiff: generateDiffString(before!, args.content, 2).diff }
          : { workflowDiffOmitted: true },
      };
    },
  });
}
