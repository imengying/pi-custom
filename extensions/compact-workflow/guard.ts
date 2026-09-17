import { createHash } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { assessTool, canonicalPath, currentShellDialect, resolveToolPath, type Assessment } from "./policy.js";
import { showReview } from "./ui.js";

type Review = typeof showReview;

/**
 * Why a call was refused, in the words the policy used.
 *
 * The panel keeps the short tag on its title row, but the model never sees the panel:
 * it only gets the text below. Repeating the rule saves a round trip of the model
 * guessing why it was blocked and re-issuing the same command.
 */
function refusal(decision: Assessment): string {
  const why = decision.reasons[0];
  return why ? `未获得用户授权，操作未执行（${why}）` : "未获得用户授权，操作未执行";
}

function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => [key, ordered(val)]),
  );
  return value;
}

export class PermissionGate {
  private receipts = new Map<string, string>();
  private queue: Promise<void> = Promise.resolve();
  private epoch = 0;
  private activeAbort: AbortController | undefined;

  constructor(private review: Review = showReview) {}

  reset(): void {
    this.epoch++;
    this.receipts.clear();
    this.activeAbort?.abort();
  }

  finish(id: string): void { this.receipts.delete(id); }

  private fingerprint(name: string, input: Record<string, unknown>, cwd: string): string {
    let target: string | undefined;
    if (["write", "edit", "read"].includes(name) && typeof (input.path ?? input.file_path) === "string") {
      target = canonicalPath(resolveToolPath((input.path ?? input.file_path) as string, cwd));
    }
    return createHash("sha256").update(JSON.stringify(ordered({
      name, input, cwd: canonicalPath(cwd), target,
    }))).digest("hex");
  }

  private async decide(name: string, input: Record<string, unknown>, decision: Assessment, ctx: ExtensionContext): Promise<boolean> {
    if (ctx.signal?.aborted) return false;
    if (!decision.approval) return true;
    if (!ctx.hasUI) return false;
    const epoch = this.epoch;
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      if (epoch !== this.epoch || ctx.signal?.aborted) return false;
      const controller = new AbortController();
      this.activeAbort = controller;
      const signal = ctx.signal ? AbortSignal.any([controller.signal, ctx.signal]) : controller.signal;
      const payload = (name === "bash" || name === "powershell") && typeof input.command === "string"
        ? input.command : JSON.stringify(input, null, 2);
      // The tag rides on the row the dialog already draws for its title, so naming the
      // rule costs no extra height; the full sentence goes to the model instead.
      const title = decision.tag ? `需要用户授权 · ${decision.tag}` : "需要用户授权";
      const accepted = await this.review(ctx, title, payload, true, signal);
      return accepted && !signal.aborted && epoch === this.epoch;
    } catch {
      // UI errors and unsupported (e.g. headless) UI must never grant access.
      return false;
    } finally {
      this.activeAbort = undefined;
      release();
    }
  }

  async preflight(id: string, name: string, input: Record<string, unknown>, ctx: ExtensionContext) {
    try {
      const decision = assessTool(name, input, ctx.cwd, currentShellDialect());
      // Bind approval to the arguments and resolved target presented to the user.
      const fingerprint = decision.approval ? this.fingerprint(name, input, ctx.cwd) : undefined;
      if (!await this.decide(name, input, decision, ctx)) {
        // The model sees only this string, so it carries the policy's own reason.
        return {
          block: true as const,
          reason: `${refusal(decision)}。请勿改写命令绕过授权，也不要重试同一条命令。`,
          terminate: true,
        };
      }
      if (fingerprint) this.receipts.set(id, fingerprint);
      return undefined;
    } catch {
      return { block: true as const, reason: "权限检查失败，操作未执行。", terminate: true };
    }
  }

  /** Also check at execution time, after any other tool-call hooks have run. */
  async beforeExecute(id: string, name: string, input: Record<string, unknown>, ctx: ExtensionContext): Promise<Assessment> {
    if (ctx.signal?.aborted) throw new Error("操作已取消");
    const decision = assessTool(name, input, ctx.cwd, currentShellDialect());
    const receipt = this.receipts.get(id);
    this.receipts.delete(id);
    if (decision.approval && receipt && receipt === this.fingerprint(name, input, ctx.cwd)) return decision;
    if (!await this.decide(name, input, decision, ctx)) throw new Error(refusal(decision));
    return decision;
  }

  async userCommand(command: string, ctx: ExtensionContext): Promise<Assessment | undefined> {
    try {
      const input = { command };
      const decision = assessTool("bash", input, ctx.cwd, currentShellDialect());
      return await this.decide("bash", input, decision, ctx) ? decision : undefined;
    } catch { return undefined; }
  }
}
