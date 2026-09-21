// The guard: three entry points for every host adapter.
//   recordPrompt(sessionId, text)            UserPromptSubmit → a new turn
//   assess(action, opts)                     PreToolUse       → classify, decide whether to ask Jev, ask, decide, remember, log
//   recordResult(sessionId, result)          PostToolUse / PostToolUseFailure → close the entry
// Everything is fail-open: an error anywhere returns SKIP and the host proceeds. docs/design.md v0.3.
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { actionOutcome, classifyAction, digestOf, pathsOf, previewOf, redact } from "./evidence.js";
import { append, cwdIdOf, DEFAULT_DIR, readEvents, replay, view } from "./ledger.js";
import { buildState } from "./context.js";
import { BUNDLE_VERSION, bundle } from "./questions.js";
import { decide, thresholds } from "./policy.js";
import { cacheKey, lookup, store } from "./cache.js";
import { logDecision } from "./log.js";
import { DEFAULT_MODEL } from "../jev.js";
import "./types.js";

const READ_LIKE = new Set(["read", "search", "external"]);
// vcs and external-write carry no tree change but a side effect (push, send, delete): jev-guard's security questions apply.
export const DEFAULT_JUDGE_KINDS = ["edit", "write-bash", "other", "check", "vcs", "external-write"];

/** `config` is ~/.jev-save/config.json as read by the caller (jev.js readConfig); the environment wins over it. */
export function settings(env = process.env, config = {}) {
  const n = (k, d) => (env[k] !== undefined && Number.isFinite(+env[k]) ? +env[k] : d);
  const mode = (env.JEV_SAVE_MODE ?? config.mode) === "advise" ? "advise" : "shadow";
  return {
    mode,
    maxCalls: n("JEV_SAVE_MAX_CALLS", 200),
    longTurn: n("JEV_SAVE_LONG_TURN", 12),
    security: env.JEV_SAVE_SECURITY !== "0",
    failClosed: Boolean(env.JEV_SAVE_FAIL_CLOSED),
    skipTools: new Set((env.JEV_SAVE_SKIP_TOOLS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)),
    // Which kinds are always judged. A bash-first workflow where most calls are one-off scripts and shell writes
    // (77% of calls judged on the author's corpus, ~3.5 min of waiting a day) can narrow this to what carries scope:
    // JEV_SAVE_JUDGE_KINDS=edit,check,vcs,external-write. Reads still follow the repeat / long-turn rule.
    judgeKinds: new Set(env.JEV_SAVE_JUDGE_KINDS ? env.JEV_SAVE_JUDGE_KINDS.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_JUDGE_KINDS),
    model: env.JEV_MODEL ?? DEFAULT_MODEL,
  };
}

/** Should this call cost a Jev round trip? docs/design.md v0.3 "언제 Jev를 부르는가". */
export function shouldJudge(cls, v, s) {
  if (v.jev_calls >= s.maxCalls) return { judge: false, why: "budget" };
  if (s.judgeKinds.has(cls.kind)) return { judge: true };
  if (READ_LIKE.has(cls.kind)) {
    if (v.same_action_count_this_turn >= 1) return { judge: true, why: "repeat" };
    if (v.calls_this_turn >= s.longTurn) return { judge: true, why: "long-turn" };
    return { judge: false, why: "read" };
  }
  return { judge: false, why: cls.kind };
}

// Hosts also deliver things that are not the user speaking as prompts: the desktop app's terminal echo
// (`<bash-input>`), slash-command echoes, injected context, interruption notices, session-resume banners.
// They still start a turn, but they are not a request and must never become original_request.
export const SYNTHETIC_PROMPT = /^\s*(?:<(?:bash-input|bash-stdout|bash-stderr|command-name|command-message|command-args|local-command-stdout|local-command-stderr|system-reminder|teammate-message|agent-message|ide_selection|ide_opened_file)\b|\[Request interrupted|Caveat:|This session is being continued|Continue from where you left off|Please continue the conversation)/i;

export function recordPrompt(sessionId, text, { dir = DEFAULT_DIR(), now = Date.now(), home = homedir() } = {}) {
  const clean = redact(String(text ?? ""), home).slice(0, 1500);
  if (!clean.trim()) return false;
  const turn = replay(readEvents(sessionId, dir), { now }).turn + 1;
  const synthetic = SYNTHETIC_PROMPT.test(clean);
  return append(sessionId, { ev: "prompt", turn, text: synthetic ? clean.slice(0, 200) : clean, digest: sha(String(text)), ...(synthetic ? { synthetic: true } : {}) }, { dir, now });
}

/**
 * @param {Action} action
 * @returns {Promise<{decision:string, advisory:null|object, emit:null|{kind:'deny'|'ask'|'context', text:string}, signals:object, cls:object, digest:string, judged:boolean, cached:boolean, latencyMs:number|null, error?:string, mode:string}>}
 */
export async function assess(action, { provider, env = process.env, config = {}, dir = DEFAULT_DIR(), now = Date.now(), home = homedir(), logPath } = {}) {
  const s = settings(env, config);
  const cls = classifyAction(action.tool, action.input, env);
  const digest = digestOf(action.tool, action.input);
  const preview = previewOf(action.tool, action.input, 120, home);
  const paths = pathsOf(action.tool, action.input).map((p) => redact(p, home));
  const base = { decision: "SKIP", advisory: null, emit: null, signals: {}, cls, digest, judged: false, cached: false, latencyMs: null, mode: s.mode };
  const cwdId = cwdIdOf(action.cwd);
  const pre = (extra) => ({ ev: "pre", turn: 0, tool_use_id: action.toolUseId, tool: action.tool, kind: cls.kind, runner: cls.runner, digest, preview, paths, cwd: redact(String(action.cwd ?? ""), home), cwd_id: cwdId, mode: s.mode, exec: "running", ...extra });
  const log = (extra) => logDecision({ event: "pre", session: sha(action.sessionId).slice(0, 12), agent: action.agent, tool: action.tool, kind: cls.kind, digest, preview, mode: s.mode, ...extra }, { path: logPath ?? undefined, now });

  let state, v;
  try {
    state = replay(readEvents(action.sessionId, dir), { now });
    v = view(state, { digest, cwdId });
  } catch (err) {
    log({ decision: "SKIP", why: "ledger", error: String(err?.message ?? err) });
    return base;
  }
  const turn = state.turn;

  if (s.skipTools.has(String(action.tool).toLowerCase())) { append(action.sessionId, pre({ turn, decision: "SKIP", judged: false }), { dir, now }); log({ turn, decision: "SKIP", why: "skip-tool" }); return base; }
  const gate = shouldJudge(cls, v, s);
  if (!gate.judge) { append(action.sessionId, pre({ turn, decision: "SKIP", judged: false }), { dir, now }); log({ turn, decision: "SKIP", why: gate.why }); return base; }

  const security = s.security && !READ_LIKE.has(cls.kind);
  const questions = bundle({ security, untrusted: false });
  const jevState = buildState(action, cls, v, { home });
  const key = cacheKey(s.model, BUNDLE_VERSION, jevState);
  let answers = lookup(action.sessionId, dir, key);
  let cached = Boolean(answers), latencyMs = null;
  if (!answers) {
    const started = Date.now();
    try {
      answers = await provider.decide(jevState, questions, { env });
      latencyMs = Date.now() - started;
      store(action.sessionId, dir, key, answers, now);
    } catch (err) {
      const error = String(err?.message ?? err);
      const closed = s.failClosed && security;
      append(action.sessionId, pre({ turn, decision: closed ? "DENY" : "SKIP", judged: false, exec: closed && s.mode === "advise" ? "blocked" : "running" }), { dir, now });
      log({ turn, decision: closed ? "DENY" : "SKIP", why: "provider-error", error, latency_ms: Date.now() - started });
      if (closed && s.mode === "advise") return { ...base, decision: "DENY", emit: { kind: "deny", text: `jev-save unavailable (${error}) and JEV_SAVE_FAIL_CLOSED is set` }, error };
      return { ...base, error };
    }
  }

  const r = decide(answers, v, cls, thresholds(env));
  let emit = null;
  if (s.mode === "advise") {
    if (r.decision === "DENY") emit = { kind: "deny", text: r.reason };
    else if (r.decision === "ASK") emit = { kind: "ask", text: r.reason };
    else if (r.advisory && !r.advisory.suppressed) emit = { kind: "context", text: r.advisory.text };
  }
  const advised = emit?.kind === "context";
  append(action.sessionId, pre({ turn, decision: r.decision, judged: true, advised, exec: emit?.kind === "deny" ? "blocked" : "running" }), { dir, now });
  log({ turn, decision: r.decision, fired: r.fired, advisory: r.advisory ? { rule: r.advisory.rule, suppressed: r.advisory.suppressed, why: r.advisory.why } : null, emitted: emit?.kind ?? null,
    signals: r.signals, margin: r.decisionMargin, cached, latency_ms: latencyMs, provider: provider.name, view: { calls: v.calls_this_turn, same: v.same_action_count_this_turn, validity: v.validity, last: v.last_outcome_of_this_action } });
  return { ...base, decision: r.decision, advisory: r.advisory, emit, signals: r.signals, judged: true, cached, latencyMs, reason: r.reason };
}

/**
 * Close an entry. `failed` is the host's error flag (PostToolUseFailure, is_error), `interrupted` an
 * abort; `output` is stdout+stderr for the runner parsers. Returns the recorded result.
 */
export function recordResult(sessionId, { toolUseId, tool, input = {}, failed = false, interrupted = false, output = "", hostSuccess = null, durationMs }, { dir = DEFAULT_DIR(), now = Date.now(), env = process.env } = {}) {
  if (!sessionId || !toolUseId) return null;
  const cls = classifyAction(tool, input, env);
  const result = actionOutcome(cls.kind, { failed, interrupted, output, hostSuccess });
  const exec = failed || interrupted ? "failed" : "completed";
  append(sessionId, { ev: "post", tool_use_id: toolUseId, exec, result, ...(typeof durationMs === "number" ? { duration_ms: durationMs } : {}) }, { dir, now });
  return { kind: cls.kind, result, exec };
}

const sha = (s) => createHash("sha1").update(String(s ?? "")).digest("hex");
