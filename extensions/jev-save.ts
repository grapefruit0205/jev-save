// pi extension: block/confirm dangerous tool calls, flag AI-directed text in tool results.
// Load with `pi -e ./extensions/jev-save.ts`, `jev-save install pi`, or `pi install git:github.com/grapefruit0205/jev-save`.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { assessAction, scanContent, collectText, excerpt, INSTRUCTION_FILE } from "../src/guard.js";
import { scanInstructionsCached } from "../src/skills.js";
import { buildContext, messagesFrom } from "../src/context.js";
import { readSession, remember } from "../src/session.js";

export default function (pi: ExtensionAPI) {
  const sessionId = (ctx: any) => ctx.sessionManager?.getSessionId?.();
  const context = (ctx: any) =>
    buildContext({ sessionId: sessionId(ctx), messages: messagesFrom(ctx.sessionManager?.getBranch?.() ?? []) });

  pi.on("tool_call", async (event, ctx) => {
    let r;
    try {
      r = await assessAction({ tool: event.toolName, input: event.input, cwd: ctx.cwd, agent: "pi", context: context(ctx) }, { signal: ctx.signal });
      if (r) remember(sessionId(ctx), "calls", { tool: event.toolName, preview: JSON.stringify(event.input).slice(0, 100), level: r.level });
    } catch (err) {
      ctx.ui.notify(`jev-save: ${(err as Error).message}`, "warning");
      return process.env.JEV_SAVE_FAIL_CLOSED ? { block: true, reason: `jev-save unavailable: ${(err as Error).message}` } : undefined;
    }
    if (!r || r.level === "allow") return;
    if (r.level === "deny") return { block: true, reason: r.message };
    if (!ctx.hasUI) return { block: true, reason: `${r.message} (no UI to ask for approval, so blocked)` };
    const ok = await ctx.ui.confirm("jev-save: approve this tool call?", r.message);
    if (!ok) return { block: true, reason: `User rejected: ${r.message}` };
  });

  pi.on("tool_result", async (event, ctx) => {
    let r;
    try {
      const source = (event.input as any)?.url ?? (event.input as any)?.path;
      const text = collectText(event.content);
      r = source && INSTRUCTION_FILE.test(source)
        ? await scanInstructionsCached({ text, source }, { signal: ctx.signal })
        : await scanContent({ text, tool: event.toolName, source, task: readSession(sessionId(ctx)).prompts.at(-1)?.text }, { signal: ctx.signal });
      if (r?.flagged) remember(sessionId(ctx), "flags", { kind: r.kind, source, tool: event.toolName, p: +r.p.toFixed(2), excerpt: excerpt(text), reported: true });
    } catch (err) {
      ctx.ui.notify(`jev-save: ${(err as Error).message}`, "warning");
      return;
    }
    if (!r?.flagged) return;
    ctx.ui.notify(r.message, "warning");
    return { content: [{ type: "text", text: `[${r.message}]` }, ...event.content] };
  });
}
