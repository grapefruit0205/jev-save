// `jev-save hook`: JSON on stdin → JSON on stdout, for Claude Code and Codex. One process per event.
//   UserPromptSubmit                 → a new turn in the ledger
//   PreToolUse                       → assess; emit deny / ask / additionalContext (advise) or nothing (shadow)
//   PostToolUse / PostToolUseFailure → close the ledger entry with the outcome
// Anything else is ignored. Failures exit 0 with no output unless JEV_SAVE_FAIL_CLOSED is enabled for
// a security-bearing PreToolUse call with mode advise and security on.
import * as claude from "./adapters/claude.js";
import * as codex from "./adapters/codex.js";
import { assess, recordPrompt, recordResult, settings, shouldFailClosed } from "./core/guard.js";
import { requiresSecurity } from "./core/evidence.js";
import { selectProvider } from "./providers/provider.js";
import { readConfig } from "./jev.js";
import { DEFAULT_DIR } from "./core/ledger.js";
import { DEFAULT_LOG } from "./core/log.js";

/** Codex stamps turn_id + model on every event; Claude Code has neither (jev-guard's detectAgent). */
export function detectAgent(event, argv = []) {
  const flag = argv.indexOf("--agent");
  if (flag >= 0 && argv[flag + 1]) return argv[flag + 1];
  return typeof event.turn_id === "string" && typeof event.model === "string" ? "codex" : "claude";
}

export async function handle(event, { agent, env = process.env, config = readConfig(env), provider, dir = env.JEV_SAVE_SESSIONS ?? DEFAULT_DIR(), logPath = env.JEV_SAVE_LOG ?? DEFAULT_LOG(), now } = {}) {
  const adapter = agent === "codex" ? codex : claude;
  const ev = event.hook_event_name;
  const sessionId = String(event.session_id ?? "");
  if (!sessionId) return null;
  if (ev === "UserPromptSubmit") { recordPrompt(sessionId, event.prompt, { dir, now }); return null; }
  if (ev === "PostToolUse" || ev === "PostToolUseFailure") { recordResult(sessionId, adapter.toResult(event), { dir, now, env }); return null; }
  if (ev !== "PreToolUse") return null;
  const result = await assess(adapter.toAction(event), { provider: provider ?? (await selectProvider(env)), env, config, dir, logPath, now });
  return adapter.toOutput(result);
}

export async function main(argv = process.argv.slice(2), stdin = process.stdin, stdout = process.stdout, env = process.env) {
  let event;
  try { event = JSON.parse(await readAll(stdin)); } catch { return; }   // not our payload: no opinion
  const agent = detectAgent(event, argv);
  let out = null;
  try { out = await handle(event, { agent, env }); }
  catch (err) {
    process.stderr.write(`jev-save: ${err?.message ?? err}\n`);
    if (event.hook_event_name === "PreToolUse" && shouldFailClosed(settings(env, readConfig(env)), requiresSecurity(event.tool_name)))
      out = (agent === "codex" ? codex : claude).failClosedOutput(`jev-save failed (${err?.message ?? err}) and JEV_SAVE_FAIL_CLOSED is set`);
  }
  if (out) stdout.write(JSON.stringify(out));
}

function readAll(stream) {
  return new Promise((resolve, reject) => {
    let s = "";
    stream.setEncoding("utf8");
    stream.on("data", (c) => (s += c));
    stream.on("end", () => resolve(s));
    stream.on("error", reject);
  });
}
