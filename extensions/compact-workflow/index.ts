import { readFile, stat, writeFile, mkdir } from "node:fs/promises";
import {
  createBashToolDefinition, createEditToolDefinition, createWriteToolDefinition,
  createLocalBashOperations, generateDiffString,
  type ExtensionAPI, type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { PermissionGate } from "./guard.js";
import { shellRenderers, editRenderers, writeRenderers } from "./renderers.js";
import { compactThinking, showReview } from "./ui.js";
import { createChineseCommandMenu } from "./command-menu.js";
import { installCompactFooter } from "./compact-footer.js";

const MAX_DIFF_BYTES = 128 * 1024;
const MAX_DIFF_LINES = 2000;

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
        "简单只读命令：自动执行，使用系统可执行文件。\n" +
        "当前工作目录内的普通文件修改：自动执行。\n" +
        "删除、提权、Git 写操作、网络操作、脚本、动态 shell 语法：执行前授权。\n" +
        "目录外写入、敏感文件、代理配置、自定义工具：执行前授权。\n\n" +
        "底部授权面板：↑↓ 选择，Enter 确认；a / 1 允许本次操作，Esc / 2 拒绝。\n" +
        "默认选中允许本次操作，等待确认没有超时；命令执行超时从批准后开始计算。\n" +
        "没有交互界面、取消或检查失败时，需要授权的操作不会执行。\n\n" +
        "这是 pi 执行入口的审批扩展。系统级沙箱未由此扩展启用；" +
        "已安装扩展自身的代码、已授权脚本的内部行为仍使用 pi 的系统权限。\n\n" +
        "工作目录：" + ctx.cwd);
    },
  });

  pi.on("tool_call", (event, ctx) =>
    gate.preflight(event.toolCallId, event.toolName, event.input as Record<string, unknown>, ctx));
  pi.on("tool_execution_end", (event) => gate.finish(event.toolCallId));

  pi.on("user_bash", async (event, ctx) => {
    const userContext = { ...ctx, cwd: event.cwd };
    const decision = await gate.userCommand(event.command, userContext);
    if (!decision) {
      return { result: { output: "命令已取消：未获得用户授权。", exitCode: 126, cancelled: true, truncated: false } };
    }
    const local = createLocalBashOperations();
    return {
      operations: {
        async exec(command, cwd, options) {
          // A shell prefix or another hook may have changed the actual command.
          const actual = command === event.command && cwd === event.cwd ? decision :
            await gate.userCommand(command, { ...ctx, cwd, signal: options.signal ?? ctx.signal });
          if (!actual || options.signal?.aborted) throw new Error("命令已取消：未获得用户授权。");
          return local.exec(actual.safeCommand ?? command, cwd, options);
        },
      },
    };
  });

  const bash = createBashToolDefinition(process.cwd());
  pi.registerTool({
    ...bash,
    ...shellRenderers,
    renderShell: "default",
    async execute(id, args, signal, onUpdate, ctx) {
      const decision = await gate.beforeExecute(id, "bash", args, ctx);
      return createBashToolDefinition(ctx.cwd).execute(
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
