// OpenCode plugin. `jev-save install opencode` drops a one-line shim into ~/.config/opencode/plugins/ that re-exports this.
// tool.execute.before throws to block; permission.ask (only fires for tools you set to "ask" in opencode.json)
// lets jev-save auto-approve the safe calls and keep the prompt for the risky ones; tool.execute.after flags results.
import { assessAction, scanContent, preview, excerpt, INSTRUCTION_FILE } from "./guard.js";
import { scanInstructionsCached } from "./skills.js";
import { buildContext, messagesFrom } from "./context.js";
import { readSession, remember } from "./session.js";

export const JevSave = async ({ client, directory }) => {
  const toast = (message, variant = "warning") =>
    client?.tui?.showToast?.({ body: { title: "jev-save", message, variant, duration: 8000 } }).catch(() => {});
  const failOpen = (err) => {
    toast(err.message, "error");
    if (process.env.JEV_SAVE_FAIL_CLOSED) throw new Error(`jev-save unavailable: ${err.message}`);
    return null;
  };

  // The session's messages, via the SDK; empty when the server can't be reached.
  const context = async (sessionID) => {
    const res = await client?.session?.messages?.({ path: { id: sessionID } }).catch(() => null);
    return buildContext({ sessionId: sessionID, messages: messagesFrom(res?.data ?? []) });
  };

  return {
    "tool.execute.before": async (input, output) => {
      const r = await assessAction({ tool: input.tool, input: output.args, cwd: directory, agent: "opencode", context: await context(input.sessionID) }).catch(failOpen);
      if (r) remember(input.sessionID, "calls", { tool: input.tool, preview: preview(output.args, 100), level: r.level });
      if (!r || r.level === "allow") return;
      if (r.level === "deny") throw new Error(r.message);
      toast(`${r.message} (set permission.${input.tool} to "ask" in opencode.json to get a real prompt)`);
    },

    "permission.ask": async (input, output) => {
      const args = { ...(input.metadata ?? {}), pattern: input.pattern, title: input.title };
      const r = await assessAction({ tool: input.type, input: args, cwd: directory, agent: "opencode", context: await context(input.sessionID) }).catch(failOpen);
      if (!r) return;
      output.status = r.level;  // allow → no prompt, ask → prompt, deny → refused
      if (r.level !== "allow") toast(r.message);
    },

    "tool.execute.after": async (input, output) => {
      const source = input.args?.url ?? input.args?.filePath ?? input.args?.path;
      const r = await (source && INSTRUCTION_FILE.test(source)
        ? scanInstructionsCached({ text: output.output, source })
        : scanContent({ text: output.output, tool: input.tool, source: preview(input.args, 120), task: readSession(input.sessionID).prompts.at(-1)?.text })
      ).catch(() => null);
      if (r?.flagged) remember(input.sessionID, "flags", { kind: r.kind, source, tool: input.tool, p: +r.p.toFixed(2), excerpt: excerpt(output.output), reported: true });
      if (!r?.flagged) return;
      toast(r.message);
      output.output = `[${r.message}]\n\n${output.output}`;
    },
  };
};

// ponytail: no default export on purpose. OpenCode's older loader treats every export as a plugin function and
// throws on an object; the newer loader only special-cases a default export. A single named function loads in both.
