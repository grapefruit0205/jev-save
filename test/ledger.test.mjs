import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { append, cwdIdOf, describe, lockReport, readEvents, replay, reserveCall, sessionPath, validityOf, view } from "../src/core/ledger.js";

const fresh = () => mkdtempSync(join(tmpdir(), "jev-save-ledger-"));
const sid = "session-1";

// A small scenario builder: t0 is the clock, every event lands 1 s after the previous one.
function scenario(dir, steps) {
  let t = 1_000_000;
  for (const s of steps) {
    t += 1000;
    if (s.prompt) append(sid, { ev: "prompt", turn: s.turn, text: s.prompt, digest: "p" + s.turn }, { dir, now: t });
    else if (s.pre) append(sid, { ev: "pre", turn: s.turn ?? 1, tool_use_id: s.id, tool: s.tool ?? "Bash", kind: s.kind ?? "check", digest: s.pre, ...(s.action ? { action: s.action } : {}), preview: s.preview ?? s.pre, paths: s.paths ?? [], cwd: s.cwd ?? "/repo", cwd_id: cwdIdOf(s.cwd ?? "/repo"), decision: s.decision ?? "ALLOW", judged: s.judged ?? false, advised: s.advised ?? false, exec: s.exec ?? "running" }, { dir, now: t });
    else if (s.post) append(sid, { ev: "post", tool_use_id: s.post, exec: s.exec ?? "completed", result: s.result ?? "pass", duration_ms: s.duration_ms, output_chars: s.output_chars }, { dir, now: t });
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
  assert.equal(validityOf(entries, "c1", cwdIdOf("/repo")).validity, "valid");
  assert.equal(validityOf(entries, "c1", cwdIdOf("/elsewhere")).validity, "unknown");   // cwd moved
  assert.equal(validityOf(entries, "never-ran", cwdIdOf("/repo")).validity, "none");

  scenario(dir, [{ pre: "e1", id: "t3", kind: "edit", tool: "Edit", preview: "src/auth.py", paths: ["src/auth.py"] }, { post: "t3" }]);
  ({ entries } = replay(readEvents(sid, dir)));
  const v = validityOf(entries, "c1", cwdIdOf("/repo"));
  assert.equal(v.validity, "stale");
  assert.deepEqual(v.changed, ["src/auth.py"]);

  scenario(dir, [{ pre: "c1", id: "t4" }, { post: "t4" }, { pre: "s1", id: "t5", kind: "other", tool: "Bash", preview: "python3 fix.py" }]);   // t5 never completes
  const later = replay(readEvents(sid, dir), { now: Date.now() + 11 * 60_000 });
  assert.equal(validityOf(later.entries, "c1", cwdIdOf("/repo")).validity, "stale");   // an unclassified command counts as a change even before it ends
});

test("a blocked repeat does not count as a change; an unfinished change is a change, an unfinished read is nothing", () => {
  const dir = fresh();
  scenario(dir, [
    { prompt: "a", turn: 1 },
    { pre: "c1", id: "t1" }, { post: "t1" },
    { pre: "x1", id: "t2", kind: "edit", exec: "blocked", decision: "DENY" },
    { pre: "r1", id: "t3", kind: "read" }, { post: "t3", result: "unknown", exec: "completed" },
  ]);
  const { entries } = replay(readEvents(sid, dir));
  const v = validityOf(entries, "c1", cwdIdOf("/repo"));
  assert.equal(v.validity, "valid");   // a read with an unreadable result is not an unknown *execution*
  scenario(dir, [{ pre: "r2", id: "t4", kind: "read" }, { prompt: "b", turn: 2 }]);   // t4 never completes → unknown exec, but a read changes nothing
  assert.equal(validityOf(replay(readEvents(sid, dir)).entries, "c1", cwdIdOf("/repo")).validity, "valid");
  scenario(dir, [{ pre: "w1", id: "t5", kind: "write-bash", turn: 2 }, { prompt: "c", turn: 3 }]);   // t5 never completes: it may have changed the tree
  assert.equal(validityOf(replay(readEvents(sid, dir)).entries, "c1", cwdIdOf("/repo")).validity, "stale");
});

test("a denial learned from the transcript closes the entry as blocked: not a run, not a change", () => {
  const dir = fresh();
  scenario(dir, [
    { prompt: "a", turn: 1 },
    { pre: "c1", id: "t1", action: "plan" }, { post: "t1", duration_ms: 14000, output_chars: 9000 },
    { pre: "c2", id: "t2", action: "plan", kind: "write-bash", preview: "terraform plan > out.txt" }, { post: "t2", exec: "denied", result: "unknown" },
  ]);
  const state = replay(readEvents(sid, dir));
  assert.equal(state.entries[1].exec, "blocked");
  const v = view(state, { digest: "c3", action: "plan", cwdId: cwdIdOf("/repo") });
  assert.equal(v.validity, "valid", "the denied write never ran");
  assert.equal(v.last_outcome_of_this_action, "pass", "the last *run* is t1, not the denial");
  assert.equal(v.last_run_same_input, false);
  assert.equal(v.last_duration_ms, 14000);
  assert.equal(v.last_output_chars, 9000);
  assert.equal(v.same_action_count_this_turn, 2, "the repeat count still sees every attempt");
});

test("the view is keyed on the action identity, and failed_runs lists identical failures with nothing changed since", () => {
  const dir = fresh();
  scenario(dir, [
    { prompt: "audit", turn: 1 },
    { pre: "p-tail", id: "t1", action: "plan" }, { post: "t1", duration_ms: 13000 },
    { pre: "r1", id: "t2", kind: "read", tool: "Read", preview: "a.tf" }, { post: "t2" },
    { pre: "p-grep", id: "t3", action: "plan" }, { post: "t3", duration_ms: 14000 },
  ]);
  let v = view(replay(readEvents(sid, dir)), { digest: "p-tail-8", action: "plan", cwdId: cwdIdOf("/repo") });
  assert.equal(v.same_action_count_this_turn, 2);
  assert.equal(v.last_pass_seq, 3, "the most recent pass of the producer, whatever pipe it wore");
  assert.equal(v.validity, "valid");
  assert.deepEqual(v.failed_runs, []);
  // credentials expire: the same producer fails, and fails again; a read in between changes nothing
  scenario(dir, [
    { pre: "p-15", id: "t4", action: "plan" }, { post: "t4", result: "fail" },
    { pre: "r2", id: "t5", kind: "read", tool: "Read", preview: "b.tf" }, { post: "t5" },
    { pre: "p-20", id: "t6", action: "plan" }, { post: "t6", result: "fail" },
  ]);
  v = view(replay(readEvents(sid, dir)), { digest: "p-12", action: "plan", cwdId: cwdIdOf("/repo") });
  assert.deepEqual(v.failed_runs, [4, 6]);
  assert.equal(v.last_outcome_of_this_action, "fail");
  assert.equal(v.validity, "stale");
  // an edit after the failures is a possible fix: the streak is over
  scenario(dir, [{ pre: "e1", id: "t7", kind: "edit", tool: "Edit", preview: "providers.tf", paths: ["providers.tf"] }, { post: "t7" }]);
  v = view(replay(readEvents(sid, dir)), { digest: "p-12", action: "plan", cwdId: cwdIdOf("/repo") });
  assert.deepEqual(v.failed_runs, []);
  // a denied attempt in the streak is not a run and does not break it
  scenario(dir, [
    { pre: "p-a", id: "t8", action: "plan" }, { post: "t8", result: "fail" },
    { pre: "p-b", id: "t9", action: "plan", kind: "write-bash" }, { post: "t9", exec: "denied", result: "unknown" },
    { pre: "p-c", id: "t10", action: "plan" }, { post: "t10", result: "fail" },
  ]);
  v = view(replay(readEvents(sid, dir)), { digest: "p-12", action: "plan", cwdId: cwdIdOf("/repo") });
  assert.deepEqual(v.failed_runs, [8, 10]);
});

test("advisory bookkeeping counts over a window of entries and per action, so a hundred-call headless turn is not one budget", () => {
  const dir = fresh();
  const steps = [{ prompt: "go", turn: 1 }];
  for (let i = 1; i <= 30; i++) steps.push({ pre: `r${i}`, id: `t${i}`, kind: "read", tool: "Read", action: i % 10 === 0 ? "plan" : `r${i}`, advised: i === 5 || i === 10 }, { post: `t${i}` });
  scenario(dir, steps);
  const v = view(replay(readEvents(sid, dir)), { digest: "x", action: "plan", cwdId: cwdIdOf("/repo") });
  assert.equal(v.advisories_this_turn, 2);
  assert.equal(v.advisories_in_window, 0, "both advisories are older than the last 20 entries");
  assert.deepEqual(v.advised_for_this_action, [{ rule: "advisory", calls_since: 20 }], "entry 10 was the last advisory on this action; 20 calls since");
  assert.equal(v.calls_since_last_advisory, 20);
  assert.deepEqual(view(replay(readEvents(sid, dir)), { digest: "x", action: "other", cwdId: cwdIdOf("/repo") }).advised_for_this_action, []);
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
  const v = view(state, { digest: "r1", cwdId: cwdIdOf("/repo") });
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
  const none = view(state, { digest: "c9", cwdId: cwdIdOf("/repo") });
  assert.equal(none.validity, "none");
  assert.equal(none.calls_since_last_advisory, 2);
});

test("synthetic prompts open a turn but never become the request", () => {
  const dir = fresh();
  append(sid, { ev: "prompt", turn: 1, text: "<bash-input>npm test</bash-input><bash-stdout>ok</bash-stdout>", digest: "p1", synthetic: true }, { dir });
  let v = view(replay(readEvents(sid, dir)), { digest: "d", cwdId: cwdIdOf("/repo") });
  assert.equal(v.turn, 1);
  assert.equal(v.original_request, null);
  assert.deepEqual(v.recent_instructions, []);
  append(sid, { ev: "prompt", turn: 2, text: "fix the login bug", digest: "p2" }, { dir });
  append(sid, { ev: "prompt", turn: 3, text: "<system-reminder>…", digest: "p3", synthetic: true }, { dir });
  v = view(replay(readEvents(sid, dir)), { digest: "d", cwdId: cwdIdOf("/repo") });
  assert.equal(v.turn, 3);
  assert.equal(v.original_request, "fix the login bug");
  assert.deepEqual(v.recent_instructions, ["fix the login bug"]);
});

test("cwd identity: the same directory under $HOME compares equal however it was displayed (review P2)", () => {
  assert.equal(cwdIdOf("/home/u/repo"), cwdIdOf("/home/u/repo/"));
  assert.equal(cwdIdOf("/home/u/repo"), cwdIdOf("/home/u/./repo"));
  assert.notEqual(cwdIdOf("/home/u/repo"), cwdIdOf("/home/u/other"));
  assert.equal(cwdIdOf(""), "");
});

test("compaction keeps the tail and the prompts, and the file stays readable", () => {
  const dir = fresh();
  append(sid, { ev: "prompt", turn: 1, text: "first", digest: "p1" }, { dir });
  const big = "y".repeat(6000);
  for (let i = 0; i < 400; i++) append(sid, { ev: "pre", turn: 1, tool_use_id: "t" + i, tool: "Bash", kind: "read", digest: "d" + i, preview: big, paths: [], cwd: "/r", exec: "running" }, { dir });
  const path = sessionPath(sid, dir);
  assert.ok(statSync(path).size < 2 * 1024 * 1024, "compaction ran and the file is back under the trigger");
  const events = readEvents(sid, dir);
  assert.equal(events[0].ev, "snapshot");
  assert.equal(replay(events).original_request, "first");
  assert.equal(events.at(-1).tool_use_id, "t399");
  assert.ok(events.length <= 421 && events.length > 100);
});

const LEDGER_URL = new URL("../src/core/ledger.js", import.meta.url).href;
const run = (script) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "ignore", "inherit"] });
  child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`child exited ${code}`))));
});

test("append waits for an explicitly acquired lock, independent of child startup time", async () => {
  const dir = fresh();
  const lock = sessionPath(sid, dir) + ".lock";
  mkdirSync(dir, { recursive: true });
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { mkdirSync, rmdirSync, existsSync } from "node:fs";
    import assert from "node:assert/strict";
    mkdirSync(${JSON.stringify(lock)});
    process.stdout.write("locked\\n");
    process.stdin.once("data", () => setTimeout(() => {
      assert.equal(existsSync(${JSON.stringify(sessionPath(sid, dir))}), false, "no append under the lock");
      rmdirSync(${JSON.stringify(lock)}); process.stdin.destroy();
    }, 100));
  `], { stdio: ["pipe", "pipe", "inherit"] });
  const done = new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`holder exited ${code}`))); });
  await new Promise((resolve, reject) => { child.stdout.once("data", resolve); child.on("error", reject); child.on("exit", () => reject(new Error("holder exited before ready"))); });
  child.stdin.write("release soon\n");
  const appended = append(sid, { ev: "prompt", turn: 1, text: "x", digest: "p1" }, { dir });
  await done;
  assert.equal(appended, true);
  assert.equal(readEvents(sid, dir).length, 1);
});

test("lock timeout never writes under another owner and marks evidence unknown, even for an old lock", () => {
  const dir = fresh(), lock = sessionPath(sid, dir) + ".lock";
  scenario(dir, [{ prompt: "fix", turn: 1 }, { pre: "c1", id: "t1" }, { post: "t1" }]);
  const before = readFileSync(sessionPath(sid, dir), "utf8");
  mkdirSync(lock);
  writeFileSync(join(lock, "pid"), String(process.pid));   // a live owner: this very process
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  assert.equal(append(sid, { ev: "pre", tool_use_id: "lost-edit", kind: "edit" }, { dir }), false);
  assert.equal(readFileSync(sessionPath(sid, dir), "utf8"), before);
  assert.equal(existsSync(lock), true, "never steal a possibly live writer's lock");
  rmSync(lock, { recursive: true, force: true });
  const state = replay(readEvents(sid, dir));
  assert.equal(view(state, { digest: "c1", cwdId: cwdIdOf("/repo") }).validity, "unknown");
  assert.equal(reserveCall(sid, { dir }).why, "ledger", "do not spend calls on incomplete evidence");
});

test("later failed, unknown and in-flight runs supersede earlier passing evidence", () => {
  for (const [result, exec, expected] of [["fail", "failed", "stale"], ["unknown", "completed", "unknown"], [null, "running", "unknown"]]) {
    const entries = [
      { seq: 1, digest: "a", kind: "check", exec: "completed", result: "pass", cwd_id: "r" },
      { seq: 2, digest: "a", kind: "check", exec, result, cwd_id: "r" },
    ];
    assert.equal(validityOf(entries, "a", "r").validity, expected);
    entries.push({ seq: 3, digest: "a", kind: "check", exec: "completed", result: "pass", cwd_id: "r" });
    assert.equal(validityOf(entries, "a", "r").validity, "valid", "a new observed pass establishes a new baseline");
  }
});

test("compaction preserves the original request, turn/sequence numbers and provider attempts", () => {
  const dir = fresh();
  for (let i = 0; i < 25; i++) append(sid, { ev: "prompt", text: `request-${i}` }, { dir, now: i });
  for (let i = 0; i < 7; i++) assert.equal(reserveCall(sid, { dir, limit: 7 }).ok, true);
  for (let i = 0; i < 800; i++) append(sid, { ev: "pre", tool_use_id: `u${i}`, kind: "read", preview: "x".repeat(6000), attempt_recorded: true }, { dir, now: 1000 - i });
  const state = replay(readEvents(sid, dir));
  assert.equal(state.original_request, "request-0");
  assert.equal(state.turn, 25);
  assert.equal(state.seq, 800);
  assert.equal(state.attempts, 7);
  assert.equal(reserveCall(sid, { dir, limit: 7 }).why, "budget");
  assert.equal(state.entries.at(-1).tool_use_id, "u799", "append order survives nonmonotonic timestamps");
});

test("provider reservations enforce one shared limit across processes", async () => {
  const dir = fresh();
  const script = `import { reserveCall } from ${JSON.stringify(LEDGER_URL)};
    for (let i = 0; i < 10; i++) reserveCall(${JSON.stringify(sid)}, { dir: ${JSON.stringify(dir)}, limit: 7 });`;
  await Promise.all(Array.from({ length: 4 }, () => run(script)));
  assert.equal(replay(readEvents(sid, dir)).attempts, 7);
});

test("concurrent writers through compaction lose nothing: every writer's surviving events are a contiguous suffix (review P2)", async () => {
  const dir = fresh();
  const WRITERS = 4, N = 250;
  const script = (w) => `import { append } from ${JSON.stringify(LEDGER_URL)};
    const big = "y".repeat(6000);
    for (let i = 0; i < ${N}; i++) append(${JSON.stringify(sid)}, { ev: "pre", turn: 1, tool_use_id: "w${w}-" + i, tool: "Bash", kind: "read", digest: "d", preview: big, paths: [], cwd: "/r", exec: "running", w: ${w}, n: i }, { dir: ${JSON.stringify(dir)} });`;
  await Promise.all(Array.from({ length: WRITERS }, (_, w) => run(script(w))));
  const raw = readFileSync(sessionPath(sid, dir), "utf8").split("\n").filter(Boolean);
  const events = readEvents(sid, dir);
  assert.equal(events.length, raw.length, "no partial or torn lines");
  assert.ok(statSync(sessionPath(sid, dir)).size < 2 * 1024 * 1024, "compaction happened and the file is under the trigger");
  // Compaction legitimately drops the oldest events in file order, so a writer that finished early may have none
  // left; what can never happen under the lock is a hole inside a writer's surviving sequence or a torn line.
  // (Run against a copy of ledger.js with the lock removed, this scenario lost a writer's newest event.)
  let survivors = 0;
  for (let w = 0; w < WRITERS; w++) {
    const ns = events.filter((e) => e.w === w).map((e) => e.n).sort((a, b) => a - b);
    survivors += ns.length;
    for (let i = 1; i < ns.length; i++) assert.equal(ns[i], ns[i - 1] + 1, `writer ${w}: gap after ${ns[i - 1]} — an event was lost to a compaction race`);
  }
  assert.ok(survivors >= 100, "the kept window is there");
  assert.equal(existsSync(sessionPath(sid, dir) + ".lock"), false, "the lock is released");
});

test("an orphaned lock (owner pid gone, or far older than any hook) is reclaimed instead of disabling the session", async () => {
  const dir = fresh(), lock = sessionPath(sid, dir) + ".lock";
  scenario(dir, [{ prompt: "fix", turn: 1 }]);
  // 1. owner pid is dead: a child takes the lock, writes its pid, and exits without releasing
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", `require("fs").mkdirSync(${JSON.stringify(lock)}); require("fs").writeFileSync(${JSON.stringify(join(lock, "pid"))}, String(process.pid));`], { stdio: "inherit" });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`child ${code}`))));
  });
  assert.equal(existsSync(lock), true);
  assert.deepEqual(lockReport(dir).orphans, [lock]);
  const t0 = Date.now();
  assert.equal(append(sid, { ev: "pre", tool_use_id: "t1", kind: "edit" }, { dir }), true, "reclaimed and appended");
  assert.ok(Date.now() - t0 < 400, "without waiting out the lock timeout");
  assert.equal(existsSync(lock), false, "released after use");
  assert.equal(existsSync(sessionPath(sid, dir) + ".uncertain"), false, "no gap marker: the session stays alive");
  assert.equal(reserveCall(sid, { dir }).ok, true);
  // 2. no pid file but far older than any hook the host could still be running
  mkdirSync(lock);
  const ancient = new Date(Date.now() - 20 * 60_000);
  utimesSync(lock, ancient, ancient);
  assert.equal(append(sid, { ev: "pre", tool_use_id: "t2", kind: "edit" }, { dir }), true);
  assert.equal(existsSync(lock), false);
  // 3. no pid and a recent mtime: an owner between mkdir and its pid write, alive — wait, then give up
  mkdirSync(lock);
  const t1 = Date.now();
  assert.equal(append(sid, { ev: "pre", tool_use_id: "t3", kind: "edit" }, { dir }), false);
  assert.ok(Date.now() - t1 >= 450, "waited for the owner");
  assert.equal(existsSync(lock), true, "not stolen");
  rmSync(lock, { recursive: true, force: true });
});
