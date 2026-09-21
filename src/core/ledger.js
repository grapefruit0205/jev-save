// The session ledger: what the hooks observed, one JSON line per event, append-only.
//
// Every hook invocation is a separate process, and Claude Code runs matching hooks in parallel, so the
// store must survive concurrent writers. Appending one short line with O_APPEND is atomic on every
// platform we care about; nobody ever reads-modifies-writes the file. The only rewrite is compaction, which
// takes an exclusive lock (mkdir) and replaces the file atomically. Readers replay the file into entries.
//
// Design: docs/design.md §4 (v0.2) and the v0.3 note. Replaces jev-guard's session.js for the guard path;
// session.js stays for the adapters that still use it.
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import "./types.js";

export const DEFAULT_DIR = () => process.env.JEV_SAVE_SESSIONS ?? join(homedir(), ".jev-save", "sessions");
const MAX_LINE = 8 * 1024;
const COMPACT_AT = 2 * 1024 * 1024;
const KEEP_EVENTS = 400;
const KEEP_PROMPTS = 20;
const LOCK_STALE_MS = 30_000;
const UNKNOWN_AFTER_MS = 10 * 60_000;
const CHANGE_KINDS = new Set(["edit", "write-bash", "other"]);
const CLIP_PROMPT = 1500;
const CLIP_INSTRUCTION = 300;

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
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const fd = openSync(path, "a", 0o600);
    try { writeSync(fd, line); } finally { closeSync(fd); }
  } catch { return false; }
  try { if (statSync(path).size > COMPACT_AT) compact(path, now); } catch { /* compaction is best effort */ }
  return true;
}

/** Keep the last KEEP_EVENTS events and the last KEEP_PROMPTS prompts; a `post` whose `pre` was dropped is kept anyway (harmless). */
function compact(path, now) {
  const lock = path + ".lock";
  try { mkdirSync(lock); }
  catch {
    try { if (now - statSync(lock).mtimeMs < LOCK_STALE_MS) return; rmdirSync(lock); mkdirSync(lock); } catch { return; }
  }
  try {
    const events = parse(readFileSync(path, "utf8"));
    const prompts = events.filter((e) => e.ev === "prompt").slice(-KEEP_PROMPTS);
    const rest = [];   // newest first, bounded by count and by bytes so the file really shrinks
    let bytes = 0;
    for (let i = events.length - 1; i >= 0 && rest.length < KEEP_EVENTS && bytes < COMPACT_AT / 2; i--) {
      if (events[i].ev === "prompt") continue;
      rest.push(events[i]);
      bytes += JSON.stringify(events[i]).length + 1;
    }
    const kept = [...prompts, ...rest.reverse()].sort((a, b) => a.at - b.at || 0);
    const tmp = path + ".tmp";
    writeFileSync(tmp, kept.map((e) => JSON.stringify(e)).join("\n") + "\n", { mode: 0o600 });
    renameSync(tmp, path);
  } finally { try { rmdirSync(lock); } catch { /* ignore */ } }
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
  try { return parse(readFileSync(sessionPath(sessionId, dir), "utf8")); } catch { return []; }
}

/**
 * Replay the events into a session state. `pre` events become entries; `post` events complete them.
 * A `pre` still `running` when a later prompt arrived, or older than 10 minutes, is reconciled to
 * `unknown` — the host never told us how it ended, so it is not evidence of anything.
 * @returns {{turn:number, prompts:{turn:number,text:string,digest:string,at:number}[], entries:LedgerEntry[]}}
 */
export function replay(events, { now = Date.now() } = {}) {
  const prompts = [];
  const entries = [];
  const byId = new Map();
  let seq = 0;
  let lastPromptAt = -Infinity;
  for (const e of events) {
    if (e.ev === "prompt") {
      prompts.push({ turn: prompts.length + 1, text: String(e.text ?? ""), digest: String(e.digest ?? ""), at: e.at ?? 0, synthetic: Boolean(e.synthetic) });
      lastPromptAt = e.at ?? lastPromptAt;
    } else if (e.ev === "pre") {
      const entry = {
        seq: ++seq, turn: prompts.length, tool_use_id: String(e.tool_use_id ?? `seq-${seq}`), tool: String(e.tool ?? ""), kind: e.kind ?? "other",
        runner: e.runner, digest: String(e.digest ?? ""), preview: String(e.preview ?? ""), paths: Array.isArray(e.paths) ? e.paths : [], cwd: String(e.cwd ?? ""),
        decision: e.decision ?? "SKIP", judged: Boolean(e.judged), advised: Boolean(e.advised),
        exec: e.exec === "blocked" ? "blocked" : "running", result: null,
        started_at: e.at ?? 0, ended_at: null, duration_ms: null,
      };
      entries.push(entry);
      if (entry.exec === "running") byId.set(entry.tool_use_id, entry);
    } else if (e.ev === "post") {
      const entry = byId.get(String(e.tool_use_id ?? ""));
      if (!entry || entry.exec !== "running") continue;
      entry.exec = e.exec === "failed" ? "failed" : "completed";
      entry.result = e.result === "pass" || e.result === "fail" ? e.result : "unknown";
      entry.ended_at = e.at ?? null;
      entry.duration_ms = typeof e.duration_ms === "number" ? e.duration_ms : entry.ended_at != null ? Math.max(0, entry.ended_at - entry.started_at) : null;
      byId.delete(entry.tool_use_id);
    }
  }
  for (const entry of entries) {
    if (entry.exec !== "running") continue;
    if (entry.started_at < lastPromptAt || now - entry.started_at > UNKNOWN_AFTER_MS) { entry.exec = "unknown"; entry.result = "unknown"; }
  }
  return { turn: prompts.length, prompts, entries };
}

/**
 * Validity of the last passing run of `digest` as of now. Pure; the rules of docs/design.md §3 minus the
 * git fingerprint (deferred with enforcement), which is why this can only ever be an upper bound.
 * @returns {{validity:'valid'|'stale'|'unknown'|'none', lastPassSeq:number|null, changed:string[], unknown:boolean}}
 */
export function validityOf(entries, digest, cwd) {
  let last = null;
  for (const e of entries) if (e.digest === digest && e.exec === "completed" && e.result === "pass") last = e;
  if (!last) return { validity: "none", lastPassSeq: null, changed: [], unknown: false };
  const after = entries.filter((e) => e.seq > last.seq);
  const changed = after.filter((e) => CHANGE_KINDS.has(e.kind) && e.exec !== "blocked").map((e) => e.paths[0] ?? e.preview);
  const unknown = after.some((e) => e.exec === "unknown") || (cwd != null && last.cwd && cwd !== last.cwd);
  const validity = changed.length ? "stale" : unknown ? "unknown" : "valid";
  return { validity, lastPassSeq: last.seq, changed, unknown };
}

/**
 * Everything policy and context need about the session at the moment of `action` (already classified:
 * `digest`, `kind`, `cwd`). Does not mutate anything.
 * @returns {View}
 */
export function view(state, { digest, cwd } = {}) {
  const { turn, prompts, entries } = state;
  const thisTurn = entries.filter((e) => e.turn === turn);
  const same = thisTurn.filter((e) => e.digest === digest);
  const lastOfAction = [...entries].reverse().find((e) => e.digest === digest && (e.exec === "completed" || e.exec === "failed" || e.exec === "unknown"));
  const v = validityOf(entries, digest, cwd);
  const kinds = { read: 0, search: 0, check: 0, edit: 0 };
  for (const e of thisTurn) if (e.kind in kinds) kinds[e.kind]++; else if (e.kind === "write-bash") kinds.edit++;
  const advisedIdx = thisTurn.map((e, i) => (e.advised ? i : -1)).filter((i) => i >= 0);
  const real = prompts.filter((p) => !p.synthetic);   // what the user actually said; synthetic prompts only open turns
  return {
    turn,
    original_request: real.length ? clip(real[0].text, CLIP_PROMPT) : null,
    recent_instructions: real.slice(-3).map((p) => clip(p.text, CLIP_INSTRUCTION)),
    recent: entries.slice(-10),
    calls_this_turn: thisTurn.length,
    kinds_this_turn: kinds,
    same_action_count_this_turn: same.length,
    last_outcome_of_this_action: lastOfAction?.result ?? null,
    last_pass_seq: v.lastPassSeq,
    changed_since_last_pass: v.changed,
    unknown_since_last_pass: v.unknown,
    validity: v.validity,
    jev_calls: entries.filter((e) => e.judged).length,
    advisories_this_turn: advisedIdx.length,
    advisories_for_this_action_this_turn: same.filter((e) => e.advised).length,
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
