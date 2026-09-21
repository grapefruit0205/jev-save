import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { append, describe, readEvents, replay, sessionPath, validityOf, view } from "../src/core/ledger.js";

const fresh = () => mkdtempSync(join(tmpdir(), "jev-save-ledger-"));
const sid = "session-1";

// A small scenario builder: t0 is the clock, every event lands 1 s after the previous one.
function scenario(dir, steps) {
  let t = 1_000_000;
  for (const s of steps) {
    t += 1000;
    if (s.prompt) append(sid, { ev: "prompt", turn: s.turn, text: s.prompt, digest: "p" + s.turn }, { dir, now: t });
    else if (s.pre) append(sid, { ev: "pre", turn: s.turn ?? 1, tool_use_id: s.id, tool: s.tool ?? "Bash", kind: s.kind ?? "check", digest: s.pre, preview: s.preview ?? s.pre, paths: s.paths ?? [], cwd: s.cwd ?? "/repo", decision: s.decision ?? "ALLOW", judged: s.judged ?? false, advised: s.advised ?? false, exec: s.exec ?? "running" }, { dir, now: t });
    else if (s.post) append(sid, { ev: "post", tool_use_id: s.post, exec: s.exec ?? "completed", result: s.result ?? "pass", duration_ms: s.duration_ms }, { dir, now: t });
  }
  return t;
}

test("append writes one line per event with private modes and never throws on a bad dir", () => {
  const dir = fresh();
  assert.equal(append(sid, { ev: "prompt", turn: 1, text: "fix login", digest: "p1" }, { dir }), true);
  assert.equal(append(sid, { ev: "pre", turn: 1, tool_use_id: "t1", tool: "Bash", kind: "check", digest: "c1", preview: "pytest -q", paths: [], cwd: "/repo", exec: "running" }, { dir }), true);
  const path = sessionPath(sid, dir);
  assert.equal(readFileSync(path, "utf8").split("\n").filter(Boolean).length, 2);
  if (process.platform !== "win32") { assert.equal(statSync(path).mode & 0o777, 0o600); assert.equal(statSync(dir).mode & 0o777, 0o700); }
  assert.equal(append("", { ev: "prompt" }, { dir }), false);
  // an unwritable location: a directory "under" an existing file fails with ENOTDIR at once
  // (not /proc: Node's recursive mkdirSync spins forever there because procfs answers ENOENT with an existing parent)
  assert.equal(append(sid, { ev: "prompt" }, { dir: join(path, "not-a-dir") }), false);
});

test("an oversized line is clipped rather than dropped", () => {
  const dir = fresh();
  append(sid, { ev: "prompt", turn: 1, text: "x".repeat(20_000), digest: "p1" }, { dir });
  const [e] = readEvents(sid, dir);
  assert.ok(e.text.length < 300 && e.text.endsWith("…"));
  assert.equal(e.digest, "p1");
});

test("replay joins pre and post by tool_use_id; a failure or an interrupt is not a pass", () => {
  const dir = fresh();
  scenario(dir, [
    { prompt: "fix login", turn: 1 },
    { pre: "c1", id: "t1" }, { post: "t1", result: "pass", duration_ms: 4200 },
    { pre: "c1", id: "t2" }, { post: "t2", exec: "failed", result: "fail" },
    { pre: "c1", id: "t3" }, { post: "t3", result: "unknown" },
  ]);
  const { turn, entries } = replay(readEvents(sid, dir));
  assert.equal(turn, 1);
  assert.deepEqual(entries.map((e) => [e.seq, e.exec, e.result]), [[1, "completed", "pass"], [2, "failed", "fail"], [3, "completed", "unknown"]]);
  assert.equal(entries[0].duration_ms, 4200);
  assert.equal(entries[1].duration_ms, 1000);   // from timestamps when the post carries none
});

test("a running pre is reconciled to unknown after a new prompt or after ten minutes, never a blocked one", () => {
  const dir = fresh();
  const t = scenario(dir, [
    { prompt: "a", turn: 1 },
    { pre: "c1", id: "t1" },                       // never completed, then a prompt arrives
    { prompt: "b", turn: 2 },
    { pre: "c2", id: "t2", exec: "blocked", decision: "RETRY" },
    { pre: "c3", id: "t3" },                       // still running, recent
  ]);
  const { entries } = replay(readEvents(sid, dir), { now: t + 1000 });
  assert.deepEqual(entries.map((e) => e.exec), ["unknown", "blocked", "running"]);
  const late = replay(readEvents(sid, dir), { now: t + 11 * 60_000 });
  assert.deepEqual(late.entries.map((e) => e.exec), ["unknown", "blocked", "unknown"]);
  assert.equal(late.entries[1].result, null);
});

test("validity: valid only when nothing observed changed and nothing is unknown since the last pass", () => {
  const dir = fresh();
  scenario(dir, [
    { prompt: "fix login", turn: 1 },
    { pre: "c1", id: "t1" }, { post: "t1" },
    { pre: "r1", id: "t2", kind: "read", tool: "Read", preview: "src/auth.py" }, { post: "t2" },
  ]);
  let { entries } = replay(readEvents(sid, dir));
  assert.equal(validityOf(entries, "c1", "/repo").validity, "valid");
  assert.equal(validityOf(entries, "c1", "/elsewhere").validity, "unknown");   // cwd moved
  assert.equal(validityOf(entries, "never-ran", "/repo").validity, "none");

  scenario(dir, [{ pre: "e1", id: "t3", kind: "edit", tool: "Edit", preview: "src/auth.py", paths: ["src/auth.py"] }, { post: "t3" }]);
  ({ entries } = replay(readEvents(sid, dir)));
  const v = validityOf(entries, "c1", "/repo");
  assert.equal(v.validity, "stale");
  assert.deepEqual(v.changed, ["src/auth.py"]);

  scenario(dir, [{ pre: "c1", id: "t4" }, { post: "t4" }, { pre: "s1", id: "t5", kind: "other", tool: "Bash", preview: "python3 fix.py" }]);   // t5 never completes
  const later = replay(readEvents(sid, dir), { now: Date.now() + 11 * 60_000 });
  assert.equal(validityOf(later.entries, "c1", "/repo").validity, "stale");   // an unclassified command counts as a change even before it ends
});

test("a blocked repeat does not count as a change; an unknown completion makes validity unknown", () => {
  const dir = fresh();
  scenario(dir, [
    { prompt: "a", turn: 1 },
    { pre: "c1", id: "t1" }, { post: "t1" },
    { pre: "x1", id: "t2", kind: "edit", exec: "blocked", decision: "DENY" },
    { pre: "r1", id: "t3", kind: "read" }, { post: "t3", result: "unknown", exec: "completed" },
  ]);
  const { entries } = replay(readEvents(sid, dir));
  const v = validityOf(entries, "c1", "/repo");
  assert.equal(v.validity, "valid");   // a read with an unreadable result is not an unknown *execution*
  scenario(dir, [{ pre: "r2", id: "t4", kind: "read" }, { prompt: "b", turn: 2 }]);   // t4 never completes → unknown exec
  assert.equal(validityOf(replay(readEvents(sid, dir)).entries, "c1", "/repo").validity, "unknown");
});

test("view: counts for this turn, repeat count, last outcome, prompts, advisory bookkeeping", () => {
  const dir = fresh();
  scenario(dir, [
    { prompt: "로그인 버그만 고쳐. DB는 건드리지 마.", turn: 1 },
    { pre: "r1", id: "t1", kind: "read", tool: "Read", preview: "src/auth.py" }, { post: "t1" },
    { pre: "c1", id: "t2", judged: true }, { post: "t2" },
    { prompt: "계속해", turn: 2 },
    { pre: "r1", id: "t3", kind: "read", tool: "Read", preview: "src/auth.py", judged: true, advised: true }, { post: "t3" },
    { pre: "s1", id: "t4", kind: "search", tool: "Grep", preview: "login" }, { post: "t4" },
    { pre: "r1", id: "t5", kind: "read", tool: "Read", preview: "src/auth.py", judged: true }, { post: "t5" },
  ]);
  const state = replay(readEvents(sid, dir));
  const v = view(state, { digest: "r1", cwd: "/repo" });
  assert.equal(v.turn, 2);
  assert.equal(v.original_request, "로그인 버그만 고쳐. DB는 건드리지 마.");
  assert.deepEqual(v.recent_instructions, ["로그인 버그만 고쳐. DB는 건드리지 마.", "계속해"]);
  assert.equal(v.calls_this_turn, 3);
  assert.deepEqual(v.kinds_this_turn, { read: 2, search: 1, check: 0, edit: 0 });
  assert.equal(v.same_action_count_this_turn, 2);
  assert.equal(v.last_outcome_of_this_action, "pass");
  assert.equal(v.jev_calls, 3);
  assert.equal(v.advisories_this_turn, 1);
  assert.equal(v.advisories_for_this_action_this_turn, 1);
  assert.equal(v.calls_since_last_advisory, 2);
  assert.equal(v.validity, "valid");
  assert.equal(describe(state.entries[1]), "#2 Bash c1 -> pass");
  const none = view(state, { digest: "c9", cwd: "/repo" });
  assert.equal(none.validity, "none");
  assert.equal(none.calls_since_last_advisory, 2);
});

test("synthetic prompts open a turn but never become the request", () => {
  const dir = fresh();
  append(sid, { ev: "prompt", turn: 1, text: "<bash-input>npm test</bash-input><bash-stdout>ok</bash-stdout>", digest: "p1", synthetic: true }, { dir });
  let v = view(replay(readEvents(sid, dir)), { digest: "d", cwd: "/repo" });
  assert.equal(v.turn, 1);
  assert.equal(v.original_request, null);
  assert.deepEqual(v.recent_instructions, []);
  append(sid, { ev: "prompt", turn: 2, text: "fix the login bug", digest: "p2" }, { dir });
  append(sid, { ev: "prompt", turn: 3, text: "<system-reminder>…", digest: "p3", synthetic: true }, { dir });
  v = view(replay(readEvents(sid, dir)), { digest: "d", cwd: "/repo" });
  assert.equal(v.turn, 3);
  assert.equal(v.original_request, "fix the login bug");
  assert.deepEqual(v.recent_instructions, ["fix the login bug"]);
});

test("compaction keeps the tail and the prompts, and the file stays readable", () => {
  const dir = fresh();
  append(sid, { ev: "prompt", turn: 1, text: "first", digest: "p1" }, { dir });
  const big = "y".repeat(6000);
  for (let i = 0; i < 400; i++) append(sid, { ev: "pre", turn: 1, tool_use_id: "t" + i, tool: "Bash", kind: "read", digest: "d" + i, preview: big, paths: [], cwd: "/r", exec: "running" }, { dir });
  const path = sessionPath(sid, dir);
  assert.ok(statSync(path).size < 2 * 1024 * 1024, "compaction ran and the file is back under the trigger");
  const events = readEvents(sid, dir);
  assert.equal(events[0].ev, "prompt");
  assert.equal(events.at(-1).tool_use_id, "t399");
  assert.ok(events.length <= 421 && events.length > 100);
});
