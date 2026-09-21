#!/usr/bin/env node
// How much of the waste jev-save targets actually exists in your own sessions, before any Jev call.
// Reads the projection written by tools/extract-corpus.mjs and replays each session through the same
// validity rules the live guard will use (src/core/validity.js semantics, inlined here so this tool is
// runnable at stage 1): a check is a *repeat candidate* when the same command already passed in this
// session and, since that pass, the hooks saw no change (edit, shell write, unclassified shell command)
// and no unknown outcome.
//
// Everything printed is a count, a duration or a redacted command. Read the caveats at the bottom of the
// report: without a git fingerprint the transcript cannot see edits made outside the agent, so the
// candidate counts are an upper bound on what the live guard could ever flag.
//
//   node tools/baserate.mjs [--in corpus/turns.jsonl] [--json] [--top 12]
import { readFileSync } from "node:fs";
import { join } from "node:path";

const args = parseArgs(process.argv.slice(2));
const file = args.in ?? join(process.cwd(), "corpus", "turns.jsonl");
const top = Number(args.top ?? 12);
const turns = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

const CHANGE_KINDS = new Set(["edit", "write-bash", "other"]);

const bySession = new Map();
for (const t of turns) { if (!bySession.has(t.session)) bySession.set(t.session, []); bySession.get(t.session).push(t); }

const stats = {
  sessions: bySession.size, turns: turns.length, tool_calls: 0,
  kinds: {}, checks: { total: 0, first: 0, repeat_candidate_same_turn: 0, repeat_candidate_cross_turn: 0, after_change: 0, after_fail: 0, after_unknown: 0, immediate_repeat: 0, by_runner: {} },
  reads: { total: 0, repeat_candidate: 0, repeat_same_turn: 0 },
  durations: { check_ms: [], candidate_ms: [] },
  candidates: new Map(),   // preview → count
  per_turn_calls: [],
};

for (const [, sessionTurns] of bySession) {
  sessionTurns.sort((a, b) => a.turn - b.turn);
  const lastPass = new Map();      // digest → {seq, turn}
  const lastOutcome = new Map();   // digest → outcome
  const lastSeen = new Map();      // digest → {seq, turn}  (reads)
  let changeSeq = 0, unknownSeq = 0, prevDigest = null;
  for (const t of sessionTurns) {
    stats.per_turn_calls.push(t.actions.length);
    for (const a of t.actions) {
      stats.tool_calls++;
      stats.kinds[a.kind] = (stats.kinds[a.kind] ?? 0) + 1;
      const validSince = Math.max(changeSeq, unknownSeq);
      if (a.kind === "check") {
        const c = stats.checks;
        c.total++;
        c.by_runner[a.runner ?? "test"] = (c.by_runner[a.runner ?? "test"] ?? 0) + 1;
        if (a.duration_ms != null) stats.durations.check_ms.push(a.duration_ms);
        if (prevDigest === a.digest) c.immediate_repeat++;
        const pass = lastPass.get(a.digest);
        const outcome = lastOutcome.get(a.digest);
        if (pass && outcome === "pass" && pass.seq > validSince) {
          if (pass.turn === t.turn) { c.repeat_candidate_same_turn++; if (a.duration_ms != null) stats.durations.candidate_ms.push(a.duration_ms); stats.candidates.set(a.preview, (stats.candidates.get(a.preview) ?? 0) + 1); }
          else c.repeat_candidate_cross_turn++;
        } else if (outcome === "fail") c.after_fail++;
        else if (pass && unknownSeq > pass.seq && unknownSeq >= changeSeq) c.after_unknown++;
        else if (pass) c.after_change++;
        else c.first++;
        if (a.outcome === "pass") lastPass.set(a.digest, { seq: a.seq, turn: t.turn });
        lastOutcome.set(a.digest, a.outcome);
      } else if (a.kind === "read" || a.kind === "search") {
        stats.reads.total++;
        const seen = lastSeen.get(a.digest);
        if (seen && seen.seq > validSince) { stats.reads.repeat_candidate++; if (seen.turn === t.turn) stats.reads.repeat_same_turn++; }
        lastSeen.set(a.digest, { seq: a.seq, turn: t.turn });
      }
      if (CHANGE_KINDS.has(a.kind)) changeSeq = a.seq;
      if (a.outcome === "unknown") unknownSeq = a.seq;
      prevDigest = a.digest;
    }
  }
}

const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : "–");
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const sec = (ms) => (ms == null ? "–" : `${(ms / 1000).toFixed(1)}s`);

const report = {
  sessions: stats.sessions, turns: stats.turns, tool_calls: stats.tool_calls,
  median_calls_per_turn: median(stats.per_turn_calls), kinds: stats.kinds,
  checks: { ...stats.checks },
  reads: stats.reads,
  check_median_ms: median(stats.durations.check_ms),
  candidate_median_ms: median(stats.durations.candidate_ms),
  candidate_total_ms: sum(stats.durations.candidate_ms),
  top_candidates: [...stats.candidates].sort((a, b) => b[1] - a[1]).slice(0, top),
};

if (args.json) { console.log(JSON.stringify(report, null, 2)); process.exit(0); }

const c = report.checks;
console.log(`jev-save base rate — ${report.sessions} sessions, ${report.turns} turns, ${report.tool_calls} tool calls (median ${report.median_calls_per_turn} per turn)\n`);
console.log("tool calls by kind:");
for (const [k, n] of Object.entries(report.kinds).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(11)} ${String(n).padStart(6)}  ${pct(n, report.tool_calls)}`);
console.log(`\nchecks: ${c.total}  (${Object.entries(c.by_runner).map(([k, n]) => `${k} ${n}`).join(", ")})`);
console.log(`  first run of a command            ${String(c.first).padStart(6)}  ${pct(c.first, c.total)}`);
console.log(`  repeat after a change             ${String(c.after_change).padStart(6)}  ${pct(c.after_change, c.total)}   legitimate`);
console.log(`  repeat after a failure            ${String(c.after_fail).padStart(6)}  ${pct(c.after_fail, c.total)}   legitimate`);
console.log(`  repeat after an unknown outcome   ${String(c.after_unknown).padStart(6)}  ${pct(c.after_unknown, c.total)}   not flaggable`);
console.log(`  repeat, still valid, new prompt   ${String(c.repeat_candidate_cross_turn).padStart(6)}  ${pct(c.repeat_candidate_cross_turn, c.total)}   user may have asked`);
console.log(`  repeat, still valid, same turn    ${String(c.repeat_candidate_same_turn).padStart(6)}  ${pct(c.repeat_candidate_same_turn, c.total)}   ← RETRY candidates`);
console.log(`  (of which immediately repeated    ${String(c.immediate_repeat).padStart(6)})`);
console.log(`\ncheck duration: median ${sec(report.check_median_ms)}; candidates median ${sec(report.candidate_median_ms)}, total ${sec(report.candidate_total_ms)} across the corpus`);
console.log(`\nreads/searches: ${report.reads.total}; identical repeat with nothing changed between: ${report.reads.repeat_candidate} (${pct(report.reads.repeat_candidate, report.reads.total)}), of which same turn ${report.reads.repeat_same_turn}`);
if (report.top_candidates.length) {
  console.log("\nmost repeated still-valid checks (same turn):");
  for (const [p, n] of report.top_candidates) console.log(`  ${String(n).padStart(4)}×  ${p}`);
}
console.log(`
caveats
  - "still valid" here means the transcript shows no edit, shell write or unclassified shell command since the
    pass. The live guard adds a git fingerprint; edits made outside the agent are invisible here, so these
    counts are an upper bound.
  - a repeat after a new prompt is excluded from the candidates: the user may have asked for it.
  - durations are wall time between the tool_use and its result in the transcript, including any wait for
    permission prompts.`);

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) o[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
  return o;
}
