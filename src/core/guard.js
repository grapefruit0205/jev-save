// The guard: three entry points for every host adapter, plus one the host never calls.
//   recordPrompt(sessionId, text)            UserPromptSubmit → a new turn
//   assess(action, opts)                     PreToolUse       → classify, decide whether to ask Jev, ask, decide, remember, log
//   recordResult(sessionId, result)          PostToolUse / PostToolUseFailure → close the entry
//   reconcile(sessionId, results)            from the host's transcript, inside assess: close the entries no hook closed
// Errors fail open by default; fail-closed requires advise + security on. See docs/design.md.
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { actionDigestOf, actionOutcome, classifyAction, digestOf, pathsOf, previewOf, redact, requiresSecurity } from "./evidence.js";
import { append, clip, cwdIdOf, DEFAULT_DIR, readEvents, replay, reserveCall, view } from "./ledger.js";
import { readTranscript } from "./transcript.js";
import { buildState } from "./context.js";
import { BUNDLE_VERSION, bundle, PROMPT_QUESTIONS } from "./questions.js";
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
    // on: jev-guard's deny/ask are sent to the host (advise mode). log: the questions are still asked and the
    // verdict recorded, but never sent — for hosts that already run their own permission classifier. off: not asked.
    security: securityMode(env.JEV_SAVE_SECURITY ?? config.security),
    failClosed: env.JEV_SAVE_FAIL_CLOSED != null && !["", "0", "off", "false", "no"].includes(String(env.JEV_SAVE_FAIL_CLOSED).toLowerCase()),
    skipTools: new Set((env.JEV_SAVE_SKIP_TOOLS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)),
    // Efficiency candidates only. Security coverage takes precedence while security is on/log.
    judgeKinds: new Set(env.JEV_SAVE_JUDGE_KINDS ? env.JEV_SAVE_JUDGE_KINDS.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_JUDGE_KINDS),
    model: env.JEV_MODEL ?? DEFAULT_MODEL,
  };
}

export function securityMode(value) {
  const v = String(value ?? "on").trim().toLowerCase();
  if (v === "0" || v === "off" || v === "false" || v === "no") return "off";
  if (v === "log" || v === "shadow" || v === "observe") return "log";
  return "on";
}

export function canEnforceSecurity(s) { return s.mode === "advise" && s.security === "on"; }
export function shouldFailClosed(s, securityRequired) { return s.failClosed && canEnforceSecurity(s) && securityRequired; }

/** Should this call cost a Jev round trip? docs/design.md v0.3 "언제 Jev를 부르는가". */
export function shouldJudge(cls, v, s) {
  if (v.jev_calls >= s.maxCalls) return { judge: false, why: "budget" };
  if (s.security !== "off" && cls.securityRequired) return { judge: true, why: "security" };
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
export const SYNTHETIC_PROMPT = /^\s*(?:<(?:bash-input|bash-stdout|bash-stderr|command-name|command-message|command-args|local-command-stdout|local-command-stderr|system-reminder|teammate-message|agent-message|task-notification|ci-monitor-event|ide_selection|ide_opened_file)\b|\[Request interrupted|Caveat:|This session is being continued|Continue from where you left off|Please continue the conversation)/i;

/** @returns {{turn:number, synthetic:boolean}|false} */
export function recordPrompt(sessionId, text, { dir = DEFAULT_DIR(), now = Date.now(), home = homedir() } = {}) {
  const clean = redact(String(text ?? ""), home).slice(0, 1500);
  if (!clean.trim()) return false;
  const turn = replay(readEvents(sessionId, dir), { now }).turn + 1;
  const synthetic = SYNTHETIC_PROMPT.test(clean);
  const ok = append(sessionId, { ev: "prompt", turn, text: synthetic ? clean.slice(0, 200) : clean, digest: sha(String(text)), ...(synthetic ? { synthetic: true } : {}) }, { dir, now });
  return ok ? { turn, synthetic } : false;
}

// A UserPromptSubmit hook has 5 s; the classification gets 3 so the prompt event is never the thing that times out.
const PROMPT_TIMEOUT_MS = 3000;

/**
 * Ask Jev what the user's message is (task / approval / paste / question / steer) and whether it points at the
 * assistant's previous message, and record the answer as a `prompt_kind` event so replay can track the request.
 * Optional at every step: no provider, no transcript, a timeout or a spent budget leave the prompt recorded and
 * unclassified, which replay treats as "changes nothing".
 * @param {{turn:number, synthetic:boolean}|false} recorded  what recordPrompt returned
 */
export async function classifyPrompt(sessionId, text, recorded, { provider, transcriptPath, dir = DEFAULT_DIR(), now = Date.now(), home = homedir(), env = process.env, config = {}, logPath } = {}) {
  if (!recorded || recorded.synthetic || !provider) return null;
  const s = settings(env, config);
  const prev = transcriptPath ? readTranscript(transcriptPath).narration : null;
  const state = { user_message: redact(String(text ?? ""), home).slice(0, 1500), previous_assistant_message: prev ? clip(redact(prev, home), 1200) : "(none)" };
  const reservation = reserveCall(sessionId, { limit: s.maxCalls, dir, now });
  if (!reservation.ok) return null;
  const started = Date.now();
  try {
    const a = await provider.decide(state, PROMPT_QUESTIONS, { env, timeoutMs: PROMPT_TIMEOUT_MS });
    const kind = a.message_kind?.choice ?? null, refers = typeof a.refers_to_previous?.p === "number" ? Math.round(a.refers_to_previous.p * 100) / 100 : null;
    append(sessionId, { ev: "prompt_kind", turn: recorded.turn, kind, refers, ...(prev ? { prev: clip(redact(prev, home), 1200) } : {}) }, { dir, now });
    logDecision({ event: "prompt", session: sha(sessionId).slice(0, 12), turn: recorded.turn, kind, refers, latency_ms: Date.now() - started, provider: provider.name, model: provider.last?.model ?? s.model }, { path: logPath ?? undefined, now });
    return { kind, refers };
  } catch (err) {
    logDecision({ event: "prompt", session: sha(sessionId).slice(0, 12), turn: recorded.turn, why: "provider-error", error: String(err?.message ?? err), latency_ms: Date.now() - started }, { path: logPath ?? undefined, now });
    return null;
  }
}

/**
 * @param {Action} action
 * @returns {Promise<{decision:string, advisory:null|object, emit:null|{kind:'deny'|'ask'|'context', text:string}, signals:object, cls:object, digest:string, judged:boolean, cached:boolean, latencyMs:number|null, error?:string, mode:string}>}
 */
export async function assess(action, { provider, env = process.env, config = {}, dir = DEFAULT_DIR(), now = Date.now(), home = homedir(), logPath } = {}) {
  const s = settings(env, config);
  const cls = classifyAction(action.tool, action.input, env);
  cls.securityRequired = requiresSecurity(action.tool, cls);
  const digest = digestOf(action.tool, action.input);
  const actionId = actionDigestOf(action.tool, action.input);
  const preview = previewOf(action.tool, action.input, 120, home);
  const paths = pathsOf(action.tool, action.input).map((p) => redact(p, home));
  const base = { decision: "SKIP", advisory: null, emit: null, signals: {}, cls, digest, judged: false, cached: false, latencyMs: null, mode: s.mode };
  const cwdId = cwdIdOf(action.cwd);
  const pre = (extra) => ({ ev: "pre", attempt_recorded: true, turn: 0, tool_use_id: action.toolUseId, tool: action.tool, kind: cls.kind, runner: cls.runner, digest, action: actionId, preview, paths, cwd: redact(String(action.cwd ?? ""), home), cwd_id: cwdId, mode: s.mode, exec: "running", ...extra });
  const log = (extra) => logDecision({ event: "pre", session: sha(action.sessionId).slice(0, 12), agent: action.agent, tool: action.tool, kind: cls.kind, digest, action: actionId, preview, mode: s.mode, ...extra }, { path: logPath ?? undefined, now });

  // The host's transcript closes what the hooks could not (a denied call fires no PostToolUse) and carries the
  // agent's stated reason for this call. Both are optional: no transcript, no reconciliation, no reason.
  const transcript = action.transcriptPath ? readTranscript(action.transcriptPath) : null;
  const statedReason = transcript?.narration ? clip(redact(transcript.narration, home), 400) : null;

  let state, v;
  try {
    if (transcript?.results.size) reconcile(action.sessionId, transcript.results, { dir, now, env });
    state = replay(readEvents(action.sessionId, dir), { now });
    v = view(state, { digest, action: actionId, cwdId });
  } catch (err) {
    log({ decision: "SKIP", why: "ledger", error: String(err?.message ?? err) });
    return base;
  }
  const turn = state.turn;

  if (s.skipTools.has(String(action.tool).toLowerCase())) { append(action.sessionId, pre({ turn, decision: "SKIP", judged: false }), { dir, now }); log({ turn, decision: "SKIP", why: "skip-tool" }); return base; }
  const gate = shouldJudge(cls, v, s);
  if (!gate.judge) { append(action.sessionId, pre({ turn, decision: "SKIP", judged: false }), { dir, now }); log({ turn, decision: "SKIP", why: gate.why }); return base; }

  const security = s.security !== "off" && cls.securityRequired;
  // the stated-reason question only makes sense for a call that repeats one that already ran
  const reason = Boolean(statedReason) && v.last_outcome_of_this_action != null;
  const questions = bundle({ security, untrusted: false, reason });
  const jevState = buildState(action, cls, v, { home, statedReason: reason ? statedReason : null });
  const key = cacheKey(s.model, BUNDLE_VERSION, { state: jevState, questions });
  let answers = lookup(action.sessionId, dir, key);
  let cached = Boolean(answers), latencyMs = null;
  if (!answers) {
    const reservation = reserveCall(action.sessionId, { limit: s.maxCalls, dir, now });
    if (!reservation.ok) {
      append(action.sessionId, pre({ turn, decision: "SKIP", judged: false }), { dir, now });
      log({ turn, decision: "SKIP", why: reservation.why });
      return base;
    }
    const started = Date.now();
    try {
      answers = await provider.decide(jevState, questions, { env });
      latencyMs = Date.now() - started;
      store(action.sessionId, dir, key, answers, now);
    } catch (err) {
      const error = String(err?.message ?? err);
      const closed = shouldFailClosed(s, cls.securityRequired);
      append(action.sessionId, pre({ turn, decision: closed ? "DENY" : "SKIP", judged: false, exec: closed && s.mode === "advise" ? "blocked" : "running" }), { dir, now });
      log({ turn, decision: closed ? "DENY" : "SKIP", why: "provider-error", error, latency_ms: Date.now() - started });
      if (closed) return { ...base, decision: "DENY", emit: { kind: "deny", text: `jev-save unavailable (${error}) and JEV_SAVE_FAIL_CLOSED is set` }, error };
      return { ...base, error };
    }
  }

  const r = decide(answers, v, cls, thresholds(env), { securityMode: s.security });
  let emit = null;
  if (s.mode === "advise") {
    if (r.decision === "DENY") emit = { kind: "deny", text: r.reason };
    else if (r.decision === "ASK") emit = { kind: "ask", text: r.reason };
    else if (r.advisory && !r.advisory.suppressed) emit = { kind: "context", text: r.advisory.text };
  }
  const advised = emit?.kind === "context" ? r.advisory.rule : false;   // which rule was sent, for the per-action cooldown
  append(action.sessionId, pre({ turn, decision: r.decision, judged: true, advised, exec: emit?.kind === "deny" ? "blocked" : "running" }), { dir, now });
  log({ turn, decision: r.decision, fired: r.fired, advisory: r.advisory ? { rule: r.advisory.rule, suppressed: r.advisory.suppressed, why: r.advisory.why } : null, emitted: emit?.kind ?? null,
    signals: r.signals, margin: r.decisionMargin, cached, latency_ms: latencyMs, provider: provider.name, model: cached ? undefined : provider.last?.model ?? s.model,
    view: { calls: v.calls_this_turn, same: v.same_action_count_this_turn, validity: v.validity, last: v.last_outcome_of_this_action, fails: v.failed_runs.length, last_ms: v.last_duration_ms, last_chars: v.last_output_chars, reason: reason || undefined, request: v.request_source ?? undefined } });
  return { ...base, decision: r.decision, advisory: r.advisory, emit, signals: r.signals, judged: true, cached, latencyMs, reason: r.reason };
}

/**
 * Close an entry. `failed` is the host's error flag (PostToolUseFailure, is_error), `interrupted` an
 * abort; `output` is stdout+stderr for the runner parsers (its size is what re-running would cost in context).
 * Returns the recorded result.
 */
export function recordResult(sessionId, { toolUseId, tool, input = {}, failed = false, interrupted = false, output = "", hostSuccess = null, durationMs }, { dir = DEFAULT_DIR(), now = Date.now(), env = process.env } = {}) {
  if (!sessionId || !toolUseId) return null;
  const cls = classifyAction(tool, input, env);
  const result = actionOutcome(cls.kind, { failed, interrupted, output, hostSuccess });
  const exec = failed || interrupted ? "failed" : "completed";
  append(sessionId, { ev: "post", tool_use_id: toolUseId, exec, result, output_chars: String(output ?? "").length, ...(typeof durationMs === "number" ? { duration_ms: durationMs } : {}) }, { dir, now });
  return { kind: cls.kind, result, exec };
}

/**
 * Close the entries still `running` whose result the host's transcript already shows: a denial (the call never
 * ran: `denied`, which replay treats as blocked), an error, or a success that fired no PostToolUse the ledger
 * saw. Idempotent: an entry closed once is no longer running.
 * @param {Map<string, {error: boolean, denied: boolean, output: string}>} results
 */
export function reconcile(sessionId, results, { dir = DEFAULT_DIR(), now = Date.now(), env = process.env } = {}) {
  const { entries } = replay(readEvents(sessionId, dir), { now });
  let closed = 0;
  for (const e of entries) {
    if (e.exec !== "running") continue;
    const r = results.get(e.tool_use_id);
    if (!r) continue;
    const post = r.denied
      ? { exec: "denied", result: "unknown" }
      : { exec: r.error ? "failed" : "completed", result: actionOutcome(e.kind, { failed: r.error, output: r.output, hostSuccess: !r.error }) };
    if (append(sessionId, { ev: "post", tool_use_id: e.tool_use_id, ...post, output_chars: r.output.length, source: "transcript" }, { dir, now })) closed++;
  }
  return closed;
}

const sha = (s) => createHash("sha1").update(String(s ?? "")).digest("hex");
