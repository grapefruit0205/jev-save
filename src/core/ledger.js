// The session ledger: what the hooks observed, one JSON line per event, append-only.
//
// Every hook invocation is a separate process, and Claude Code runs matching hooks in parallel, so the
// store must survive concurrent writers. Appends use O_APPEND while holding an exclusive lock.
// The only rewrite is compaction, and
// it runs under the same mkdir lock every append takes, so "A reads, B appends, A renames" cannot lose B's
// line. A timed-out writer never touches the active log; it marks the session's coverage as uncertain.
// Readers replay the file into entries. Compaction preserves session metadata independently of the tail.
//
// Design: docs/design.md §4 (v0.2) and the v0.3 note. Replaces jev-guard's session.js for the guard path;
// session.js stays for the adapters that still use it.
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import "./types.js";

export const DEFAULT_DIR = () => process.env.JEV_SAVE_SESSIONS ?? join(homedir(), ".jev-save", "sessions");
const MAX_LINE = 8 * 1024;
const COMPACT_AT = 2 * 1024 * 1024;
const KEEP_EVENTS = 400;
const KEEP_PROMPTS = 20;
const LOCK_WAIT_MS = 500;
// A lock whose owner process no longer exists, or that is older than any hook the host could still be
// running (ours time out at ≤ 10 s; Claude Code's default is 600 s), was left by a crashed writer.
// Reclaiming it keeps one dead hook from silently disabling evidence for the rest of the session.
const LOCK_ORPHAN_MS = 15 * 60_000;
const UNKNOWN_AFTER_MS = 10 * 60_000;
const CHANGE_KINDS = new Set(["edit", "write-bash", "other"]);
// Advisory budgets used to be per turn; a headless run is one turn of a hundred calls, so the budget is now
// counted over the last ADVISORY_WINDOW entries (a turn of fewer calls behaves as before).
const ADVISORY_WINDOW = 20;
const CLIP_PROMPT = 1500;
const CLIP_INSTRUCTION = 300;
const CLIP_PROPOSAL = 1200;
const MAX_STEERS = 2;

/** Identity of a working directory for comparison: a hash of the resolved absolute path. The redacted path
 *  (`~/repo`) is for display only and must never be compared with a raw one (review P2). */
export function cwdIdOf(cwd) {
  if (!cwd) return "";
  return createHash("sha1").update(resolve(String(cwd))).digest("hex").slice(0, 12);
}

export function sessionPath(sessionId, dir = DEFAULT_DIR()) {
  return join(dir, createHash("sha1").update(String(sessionId)).digest("hex").slice(0, 16) + ".jsonl");
}

/** Append one event. Never throws on a bad ledger: a guard that cannot remember must still let the host run. */
export function append(sessionId, event, { dir = DEFAULT_DIR(), now = Date.now() } = {}) {
  if (!sessionId || !event?.ev) return false;
  const path = sessionPath(sessionId, dir);
  const record = { v: 1, at: now, ...event };
  let line = JSON.stringify(record) + "\n";
  if (line.length > MAX_LINE) {   // clip the only fields that can be long; never drop the identity fields
    for (const k of ["text", "preview"]) if (typeof record[k] === "string") record[k] = record[k].slice(0, 200) + "…";
    if (Array.isArray(record.paths)) record.paths = record.paths.slice(0, 20);
    line = JSON.stringify(record) + "\n";
  }
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { return false; }
  const lock = path + ".lock";
  const locked = acquire(lock);
  if (!locked) { markGap(path); return false; }
  try {
    writeLine(path, line);
    try { if (statSync(path).size > COMPACT_AT) compact(path); } catch { /* compaction is best effort */ }
  } catch { markGap(path); return false; }
  finally { release(lock); }
  return true;
}

function writeLine(path, line) {
  const fd = openSync(path, "a", 0o600);
  try { writeFileSync(fd, line); } finally { closeSync(fd); }
}

// Sticky for the lifetime of this session: a missed edit cannot be reconstructed from later successes.
function markGap(path) {
  try { writeFileSync(path + ".uncertain", "coverage gap\n", { mode: 0o600 }); } catch { /* best effort */ }
}

/** Reserve one provider invocation before network I/O, atomically across hook processes. Failures consume it. */
export function reserveCall(sessionId, { limit = 200, dir = DEFAULT_DIR(), now = Date.now() } = {}) {
  if (!sessionId) return { ok: false, why: "ledger" };
  const path = sessionPath(sessionId, dir), lock = path + ".lock";
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { return { ok: false, why: "ledger" }; }
  if (!acquire(lock)) { markGap(path); return { ok: false, why: "ledger" }; }
  try {
    const state = replay(readEvents(sessionId, dir), { now });
    if (state.coverageUnknown) return { ok: false, why: "ledger" };
    if (state.attempts >= Math.max(0, limit)) return { ok: false, why: "budget" };
    writeLine(path, JSON.stringify({ v: 1, at: now, ev: "attempt" }) + "\n");
    return { ok: true };
  } catch { markGap(path); return { ok: false, why: "ledger" }; }
  finally { release(lock); }
}

/** Never steal a lock based on age: a paused writer may still own it. An orphaned lock disables evidence
 *  for this session until the user removes it after stopping the host; the tool itself still fails open. */
/** mkdir is atomic on every platform: whoever creates the directory holds the lock, and writes its pid inside.
 *  A lock is never taken over on age alone while its owner could still be alive (a paused writer may own it).
 *  It is reclaimed only when provably orphaned: the owner pid is gone from this machine, or the lock is older
 *  than LOCK_ORPHAN_MS. Whatever the dead writer was appending is lost either way; validityOf already treats
 *  a missing completion as unknown, so reclaiming loses no safety and keeps the session alive. */
function acquire(lock) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try { mkdirSync(lock); try { writeFileSync(join(lock, "pid"), String(process.pid)); } catch { /* the lock still holds */ } return true; }
    catch (err) {
      if (err?.code !== "EEXIST") return false;
      if (isOrphan(lock)) { try { rmSync(lock, { recursive: true, force: true }); } catch { /* someone else did */ } continue; }
      if (Date.now() >= deadline) return false;
      sleepSync(3);
    }
  }
}
function isOrphan(lock) {
  let age;
  try { age = Date.now() - statSync(lock).mtimeMs; } catch { return false; }   // vanished: the retry will get it
  if (age > LOCK_ORPHAN_MS) return true;
  let pid;
  try { pid = Number(readFileSync(join(lock, "pid"), "utf8")); } catch { return false; }   // no pid yet: owner is between mkdir and write, alive
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try { process.kill(pid, 0); return false; }                        // signal 0: the process exists (EPERM: exists, not ours)
  catch (e) { return e?.code === "ESRCH"; }
}
function release(lock) { try { rmSync(lock, { recursive: true, force: true }); } catch { /* best effort */ } }
/** Held, orphaned and uncertain markers under the sessions dir, for `doctor` and `stats`. */
export function lockReport(dir = DEFAULT_DIR()) {
  const out = { locks: [], orphans: [], uncertain: [] };
  let files;
  try { files = readdirSync(dir); } catch { return out; }
  for (const f of files) {
    const p = join(dir, f);
    if (f.endsWith(".lock")) { out.locks.push(p); if (isOrphan(p)) out.orphans.push(p); }
    else if (f.endsWith(".uncertain")) out.uncertain.push(p);
  }
  return out;
}
function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

/** Keep the last KEEP_EVENTS events and the last KEEP_PROMPTS prompts; a `post` whose `pre` was dropped is
 *  kept anyway (harmless). Called with the lock held. */
function compact(path) {
  {
    const events = parse(readFileSync(path, "utf8"));
    const state = replay(events);
    const kept_prompts = events.filter((e) => e.ev === "prompt").slice(-KEEP_PROMPTS);
    const keptSet = new Set(kept_prompts), turns = new Set(kept_prompts.map((e) => e.turn).filter((t) => t != null));
    const prompts = events.filter((e) => keptSet.has(e) || (e.ev === "prompt_kind" && turns.has(e.turn)));   // a kind rides with its prompt
    const rest = [];   // newest first, bounded by count and by bytes so the file really shrinks
    let bytes = 0;
    for (let i = events.length - 1; i >= 0 && rest.length < KEEP_EVENTS && bytes < COMPACT_AT / 2; i--) {
      if (["prompt", "prompt_kind", "snapshot", "attempt"].includes(events[i].ev)) continue;
      rest.push(events[i]);
      bytes += JSON.stringify(events[i]).length + 1;
    }
    // Preserve append order, not timestamps captured before a slow provider call.
    const selected = new Set([...prompts, ...rest]);
    const kept = events.filter((e) => selected.has(e)).map((e) => e.ev === "pre" ? { ...e, attempt_recorded: true } : e);
    const snapshot = { v: 1, ev: "snapshot", attempts: state.attempts, original_request: state.original_request, request: state.request,
      turn_offset: state.turn - kept_prompts.length, seq_offset: state.seq - kept.filter((e) => e.ev === "pre").length };
    const tmp = path + ".tmp";
    writeFileSync(tmp, [snapshot, ...kept].map((e) => JSON.stringify(e)).join("\n") + "\n", { mode: 0o600 });
    renameSync(tmp, path);
  }
}

function parse(text) {
  const out = [];
  for (const raw of text.split("\n")) {
    if (!raw) continue;
    try { const e = JSON.parse(raw); if (e && typeof e === "object" && e.ev) out.push(e); } catch { /* a half-written last line is normal */ }
  }
  return out;
}

export function readEvents(sessionId, dir = DEFAULT_DIR()) {
  const path = sessionPath(sessionId, dir);
  let events;
  try { events = parse(readFileSync(path, "utf8")); }
  catch (e) { events = e.code === "ENOENT" ? [] : [{ ev: "gap" }]; }
  if (existsSync(path + ".uncertain")) events.push({ ev: "gap" });
  return events;
}

/**
 * Replay the events into a session state. `pre` events become entries; `post` events complete them.
 * A `pre` still `running` when a later prompt arrived, or older than 10 minutes, is reconciled to
 * `unknown` — the host never told us how it ended, so it is not evidence of anything.
 * @returns {{turn:number, seq:number, attempts:number, original_request:string|null, coverageUnknown:boolean, prompts:{turn:number,text:string,digest:string,at:number,synthetic:boolean}[], entries:LedgerEntry[]}}
 */
export function replay(events, { now = Date.now() } = {}) {
  const prompts = [];
  const entries = [];
  const byId = new Map();
  let seq = 0;
  let turn = 0, attempts = 0, original_request = null, coverageUnknown = false;
  let request = null;   // the tracked request: {text, source, turn}, see requestAfter
  let lastPromptAt = -Infinity;
  for (const e of events) {
    if (e.ev === "snapshot") {
      attempts = e.attempts ?? 0; turn = e.turn_offset ?? 0; seq = e.seq_offset ?? 0; original_request = e.original_request ?? null; request = e.request ?? null;
    } else if (e.ev === "attempt") { attempts++; }
    else if (e.ev === "gap") { coverageUnknown = true; }
    else if (e.ev === "prompt") {
      prompts.push({ turn: ++turn, text: String(e.text ?? ""), digest: String(e.digest ?? ""), at: e.at ?? 0, synthetic: Boolean(e.synthetic), kind: null, refers: null, prev: null });
      if (!e.synthetic && original_request == null) original_request = String(e.text ?? "");
      lastPromptAt = e.at ?? lastPromptAt;
    } else if (e.ev === "prompt_kind") {
      // written after the prompt event by the same hook, once Jev has said what the message is
      const p = prompts.find((x) => x.turn === e.turn);
      if (p && !p.synthetic) { p.kind = e.kind ?? null; p.refers = typeof e.refers === "number" ? e.refers : null; p.prev = e.prev ?? null; request = requestAfter(request, p); }
    } else if (e.ev === "pre") {
      const entry = {
        seq: ++seq, turn, tool_use_id: String(e.tool_use_id ?? `seq-${seq}`), tool: String(e.tool ?? ""), kind: e.kind ?? "other",
        runner: e.runner, digest: String(e.digest ?? ""), action: String(e.action ?? e.digest ?? ""), preview: String(e.preview ?? ""), paths: Array.isArray(e.paths) ? e.paths : [], cwd: String(e.cwd ?? ""), cwd_id: String(e.cwd_id ?? ""),
        decision: e.decision ?? "SKIP", judged: Boolean(e.judged), advised: e.advised ? (typeof e.advised === "string" ? e.advised : "advisory") : false,   // the rule that was sent, or false
        exec: e.exec === "blocked" ? "blocked" : "running", result: null,
        started_at: e.at ?? 0, ended_at: null, duration_ms: null, output_chars: null,
      };
      entries.push(entry);
      if (e.judged && !e.attempt_recorded && !e.cached) attempts++; // pre-reservation ledgers
      if (entry.exec === "running") byId.set(entry.tool_use_id, entry);
    } else if (e.ev === "post") {
      const entry = byId.get(String(e.tool_use_id ?? ""));
      if (!entry || entry.exec !== "running") continue;
      // `denied`: the host refused the call before it ran (learned from the transcript, since a denial fires no
      // PostToolUse) — the same as a call the guard blocked: it changed nothing and is not a run of the action.
      entry.exec = e.exec === "denied" ? "blocked" : e.exec === "failed" ? "failed" : "completed";
      entry.result = e.result === "pass" || e.result === "fail" ? e.result : "unknown";
      entry.ended_at = e.at ?? null;
      entry.duration_ms = typeof e.duration_ms === "number" ? e.duration_ms : entry.ended_at != null ? Math.max(0, entry.ended_at - entry.started_at) : null;
      entry.output_chars = typeof e.output_chars === "number" ? e.output_chars : null;
      byId.delete(entry.tool_use_id);
    }
  }
  for (const entry of entries) {
    if (entry.exec !== "running") continue;
    if (entry.started_at < lastPromptAt || now - entry.started_at > UNKNOWN_AFTER_MS) { entry.exec = "unknown"; entry.result = "unknown"; }
  }
  return { turn, seq, prompts, entries, attempts, original_request, request, coverageUnknown };
}

/**
 * The request after one classified prompt. A task (or pasted material) replaces it — together with the assistant
 * message it points at, when it does; an approval makes the assistant's proposal the request; a steer is appended
 * to the current one (the last MAX_STEERS); a question or an unclassified prompt changes nothing. Pure.
 * @param {{text:string, source:string, turn:number, steers?:string[]}|null} request
 * @param {{turn:number, text:string, kind:string|null, refers:number|null, prev:string|null}} p
 */
export function requestAfter(request, p) {
  const prev = p.prev ? clip(String(p.prev), CLIP_PROPOSAL) : null;
  if (p.kind === "task" || p.kind === "paste") {
    const pointed = p.kind === "task" && (p.refers ?? 0) >= 0.5 && prev ? `\n\n[the assistant message this refers to]\n${prev}` : "";
    return { text: clip((p.kind === "paste" ? "[material the user provided]\n" : "") + p.text + pointed, CLIP_PROMPT), source: `${p.kind}@${p.turn}`, turn: p.turn, steers: [] };
  }
  if (p.kind === "approval") {
    return { text: clip(`[the user approved this proposal from the assistant]\n${prev ?? "(no proposal recorded)"}\n\n[user]: ${p.text}`, CLIP_PROMPT), source: `approval@${p.turn}`, turn: p.turn, steers: [] };
  }
  if (p.kind === "steer") {
    if (!request) return { text: clip(p.text, CLIP_PROMPT), source: `steer@${p.turn}`, turn: p.turn, steers: [] };
    const steers = [...(request.steers ?? []), p.text].slice(-MAX_STEERS);
    return { ...request, steers, text: clip(request.text.replace(/\n\n\[later instruction\]: [\s\S]*$/, "") + steers.map((x) => `\n\n[later instruction]: ${x}`).join(""), CLIP_PROMPT) };
  }
  return request;
}

/**
 * Validity of the last passing run of `digest` as of now. Pure; the rules of docs/design.md §3 minus the
 * git fingerprint (deferred with enforcement), which is why this can only ever be an upper bound.
 * @returns {{validity:'valid'|'stale'|'unknown'|'none', lastPassSeq:number|null, changed:string[], unknown:boolean}}
 */
export function validityOf(entries, action, cwdId) {
  let last = null;
  for (const e of entries) if (keyOf(e) === action && e.exec === "completed" && e.result === "pass") last = e;
  if (!last) return { validity: "none", lastPassSeq: null, changed: [], unknown: false };
  const after = entries.filter((e) => e.seq > last.seq);
  // a change that never reported back still counts as a change (stale); an unfinished read or search changes nothing
  const changed = after.filter((e) => CHANGE_KINDS.has(e.kind) && e.exec !== "blocked").map((e) => e.paths[0] ?? e.preview);
  const subsequent = after.filter((e) => keyOf(e) === action && e.exec !== "blocked");
  const failed = subsequent.some((e) => e.result === "fail" || e.exec === "failed");
  const unknown = subsequent.some((e) => e.result !== "pass") || (Boolean(cwdId) && cwdId !== last.cwd_id);
  const validity = changed.length || failed ? "stale" : unknown ? "unknown" : "valid";
  return { validity, lastPassSeq: last.seq, changed, unknown };
}

/** The identity every "same action" question compares: the producer digest, or the exact-input digest for entries
 *  written before it existed (and for hand-built ones). */
const keyOf = (e) => e.action ?? e.digest;

/** Seqs of the trailing runs of `action` that failed, newest last, stopping at a run that passed or at any
 *  change to the tree: the failures a fix would have interrupted. Blocked runs are not runs. */
export function trailingFailures(entries, action) {
  const seqs = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (CHANGE_KINDS.has(e.kind) && e.exec !== "blocked" && keyOf(e) !== action) break;
    if (keyOf(e) !== action || e.exec === "blocked" || e.exec === "running") continue;
    if (e.exec === "failed" || e.result === "fail") seqs.unshift(e.seq); else break;
  }
  return seqs;
}

/**
 * Everything policy and context need about the session at the moment of `action` (already classified:
 * `digest` for the exact input, `action` for the producer identity, `kind`, `cwd`). Does not mutate anything.
 * @returns {View}
 */
export function view(state, { digest, action = digest, cwdId } = {}) {
  const { turn, prompts, entries } = state;
  const thisTurn = entries.filter((e) => e.turn === turn);
  const same = thisTurn.filter((e) => keyOf(e) === action);
  const lastOfAction = [...entries].reverse().find((e) => keyOf(e) === action && (e.exec === "completed" || e.exec === "failed" || e.exec === "unknown"));
  const v = validityOf(entries, action, cwdId);
  const kinds = { read: 0, search: 0, check: 0, edit: 0 };
  for (const e of thisTurn) if (e.kind in kinds) kinds[e.kind]++; else if (e.kind === "write-bash") kinds.edit++;
  const advisedIdx = thisTurn.map((e, i) => (e.advised ? i : -1)).filter((i) => i >= 0);
  const real = prompts.filter((p) => !p.synthetic);   // what the user actually said; synthetic prompts only open turns
  return {
    turn,
    // the tracked request when the prompts were classified; the first real prompt otherwise (older ledgers, Jev down)
    original_request: state.request?.text ?? (state.original_request != null ? clip(state.original_request, CLIP_PROMPT) : real.length ? clip(real[0].text, CLIP_PROMPT) : null),
    request_source: state.request?.source ?? (state.original_request != null || real.length ? "first-prompt" : null),
    recent_instructions: real.slice(-3).map((p) => clip(p.text, CLIP_INSTRUCTION)),
    recent: entries.slice(-10),
    calls_this_turn: thisTurn.length,
    kinds_this_turn: kinds,
    same_action_count_this_turn: same.length,
    last_outcome_of_this_action: lastOfAction?.result ?? null,
    last_run_same_input: lastOfAction ? lastOfAction.digest === digest : null,
    last_duration_ms: lastOfAction?.duration_ms ?? null,
    last_output_chars: lastOfAction?.output_chars ?? null,
    failed_runs: trailingFailures(entries, action),
    last_pass_seq: v.lastPassSeq,
    changed_since_last_pass: v.changed,
    unknown_since_last_pass: v.unknown,
    validity: state.coverageUnknown ? "unknown" : v.validity,
    jev_calls: state.attempts ?? entries.filter((e) => e.judged).length,
    advisories_this_turn: advisedIdx.length,
    advisories_in_window: entries.slice(-ADVISORY_WINDOW).filter((e) => e.advised).length,
    advisories_for_this_action_this_turn: same.filter((e) => e.advised).length,
    advised_for_this_action: thisTurn.map((e, i) => (e.advised && keyOf(e) === action ? { rule: e.advised, calls_since: thisTurn.length - 1 - i } : null)).filter(Boolean),
    calls_since_last_advisory: advisedIdx.length ? thisTurn.length - 1 - advisedIdx[advisedIdx.length - 1] : Infinity,
  };
}

/** One line per entry for Jev's `recent_tool_calls`: "#12 Bash pytest -q -> pass". */
export function describe(entry) {
  const tail = entry.exec === "blocked" ? "blocked" : entry.exec === "running" ? "running" : entry.exec === "unknown" ? "outcome unknown" : entry.result ?? "";
  return `#${entry.seq} ${entry.tool} ${entry.preview}${tail ? ` -> ${tail}` : ""}`;
}

export const clip = (s, n) => (s.length > n ? s.slice(0, n) + "…" : s);

/** Sweep sessions older than 7 days once the directory passes 200 files (jev-guard's ponytail rule). */
export function prune(dir = DEFAULT_DIR(), now = Date.now()) {
  let files;
  try { files = readdirSync(dir); } catch { return; }
  if (files.length < 200) return;
  const cutoff = now - 7 * 86_400_000;
  for (const f of files) { const p = join(dir, f); try { if (statSync(p).mtimeMs < cutoff) unlinkSync(p); } catch { /* ignore */ } }
}
