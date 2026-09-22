import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assess, recordPrompt, recordResult, settings, shouldJudge } from "../src/core/guard.js";
import { parseTail, readTail } from "../src/core/transcript.js";
import { buildState, projectInput } from "../src/core/context.js";
import { cwdIdOf, readEvents, replay, view } from "../src/core/ledger.js";
import { cacheKey, canonical, lookup, store } from "../src/core/cache.js";
import { failingProvider, mockProvider } from "../src/providers/mock.js";

const fresh = () => mkdtempSync(join(tmpdir(), "jev-save-guard-"));
const sid = "sess-guard";
const act = (tool, input, extra = {}) => ({ agent: "claude", tool, input, cwd: "/repo", sessionId: sid, toolUseId: extra.id ?? `id-${Math.random().toString(36).slice(2)}`, ...extra });
const logLines = (path) => { try { return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

test("settings: shadow by default, advise on request, security on unless disabled", () => {
  assert.equal(settings({}).mode, "shadow");
  assert.equal(settings({ JEV_SAVE_MODE: "advise" }).mode, "advise");
  assert.equal(settings({ JEV_SAVE_MODE: "enforce" }).mode, "shadow");   // not a mode in this version
  assert.equal(settings({}).security, "on");
  assert.equal(settings({ JEV_SAVE_SECURITY: "0" }).security, "off");
  assert.equal(settings({ JEV_SAVE_SECURITY: "log" }).security, "log");
  assert.equal(settings({}, { security: "log" }).security, "log", "config.json applies when the environment is silent");
  assert.equal(settings({ JEV_SAVE_SECURITY: "on" }, { security: "log" }).security, "on", "the environment wins");
  assert.ok(settings({ JEV_SAVE_SKIP_TOOLS: "Foo, bar" }).skipTools.has("bar"));
});

test("shouldJudge: edits, writes, scripts and checks always; reads only on repeat or in a long turn; never past the budget", () => {
  const s = settings({});
  const v = (o) => ({ jev_calls: 0, same_action_count_this_turn: 0, calls_this_turn: 0, ...o });
  for (const kind of ["edit", "write-bash", "other", "check"]) assert.equal(shouldJudge({ kind }, v({}), s).judge, true, kind);
  assert.equal(shouldJudge({ kind: "read" }, v({}), s).judge, false);
  assert.equal(shouldJudge({ kind: "read" }, v({ same_action_count_this_turn: 1 }), s).why, "repeat");
  assert.equal(shouldJudge({ kind: "search" }, v({ calls_this_turn: 12 }), s).why, "long-turn");
  assert.equal(shouldJudge({ kind: "vcs" }, v({}), s).judge, true, "push/commit carry the security questions");
  assert.equal(shouldJudge({ kind: "external-write" }, v({}), s).judge, true);
  assert.equal(shouldJudge({ kind: "external" }, v({}), s).judge, false);
  assert.equal(shouldJudge({ kind: "edit" }, v({ jev_calls: 200 }), s).why, "budget");
  // a narrower set for bash-heavy sessions: scripts and shell writes are left alone, reads keep their rule
  const narrow = settings({ JEV_SAVE_JUDGE_KINDS: "edit, check,vcs,external-write" });
  assert.equal(shouldJudge({ kind: "write-bash" }, v({}), narrow).judge, false);
  assert.equal(shouldJudge({ kind: "other" }, v({}), narrow).judge, false);
  assert.equal(shouldJudge({ kind: "edit" }, v({}), narrow).judge, true);
  assert.equal(shouldJudge({ kind: "check" }, v({}), narrow).judge, true);
  assert.equal(shouldJudge({ kind: "read" }, v({ same_action_count_this_turn: 1 }), narrow).why, "repeat");
});

test("projectInput never forwards file bodies or patches, and redacts", () => {
  const w = projectInput("Write", { file_path: "/home/u/repo/a.py", content: "x".repeat(5000) }, "/home/u");
  assert.equal(w.file_path, "~/repo/a.py");
  assert.equal(w.content_chars, 5000);
  assert.ok(w.content_head.length <= 301 && !("content" in w));
  const e = projectInput("Edit", { file_path: "a.py", old_string: "aaa", new_string: "token=abcdef123" });
  assert.equal(e.old_string_chars, 3);
  assert.equal(e.new_string_head, "token=<redacted>");
  const p = projectInput("apply_patch", { command: "*** Begin Patch\n*** Update File: src/x.py\n@@\n-a\n+b\n*** End Patch" });
  assert.deepEqual(p.files, ["src/x.py"]);
  assert.ok(!("command" in p));
  const b = projectInput("Bash", { command: "pytest -q " + "y".repeat(5000) });
  assert.ok(b.command.length <= 2001);
  const g = projectInput("mcp__x__y", { query: "q", nested: { a: 1 }, list: [1, 2], n: 3 });
  assert.deepEqual(g, { query: "q", nested: "{…}", list: "[2 items]", n: 3 });
});

test("buildState keeps jev-guard's key names and adds the efficiency context", () => {
  const dir = fresh();
  recordPrompt(sid, "로그인 버그만 고쳐. DB는 건드리지 마.", { dir });
  const state = replay(readEvents(sid, dir));
  const v = view(state, { digest: "d", cwdId: cwdIdOf("/repo") });
  const st = buildState(act("Bash", { command: "pytest -q" }), { kind: "check", runner: "test" }, v, { home: "/home/u" });
  assert.deepEqual(st.context.user_recent_messages, ["로그인 버그만 고쳐. DB는 건드리지 마."]);
  assert.equal(st.context.original_request, "로그인 버그만 고쳐. DB는 건드리지 마.");
  assert.equal(st.context.proposed_action_kind, "check (test)");
  assert.equal(st.context.validity, "none");
  assert.deepEqual(st.context.this_turn, { calls: 0, reads: 0, searches: 0, checks: 0, edits: 0 });
  assert.equal(st.tool, "Bash");
  assert.deepEqual(st.input, { command: "pytest -q" });
  assert.ok(!("recent_tool_calls" in st.context), "empty lists are dropped");
});

test("recordPrompt marks host-injected messages as synthetic", () => {
  const dir = fresh();
  recordPrompt(sid, "<bash-input>cd x && npm test</bash-input><bash-stdout>61 pass</bash-stdout>", { dir });
  recordPrompt(sid, "[Request interrupted by user]", { dir });
  recordPrompt(sid, "로그인 버그만 고쳐.", { dir });
  const st = replay(readEvents(sid, dir));
  assert.deepEqual(st.prompts.map((p) => p.synthetic), [true, true, false]);
  assert.equal(view(st, { digest: "d", cwdId: cwdIdOf("/repo") }).original_request, "로그인 버그만 고쳐.");
});

test("canonical JSON is key-order independent, so the cache key is stable", () => {
  assert.equal(canonical({ b: 1, a: [{ d: 2, c: 3 }] }), canonical({ a: [{ c: 3, d: 2 }], b: 1 }));
  assert.equal(cacheKey("m", 1, { a: 1, b: 2 }), cacheKey("m", 1, { b: 2, a: 1 }));
  assert.notEqual(cacheKey("m", 1, { a: 1 }), cacheKey("m", 2, { a: 1 }));
  const dir = fresh();
  assert.equal(lookup("s", dir, "k"), null);
  assert.equal(store("s", dir, "k", { necessary: { p: 0.5 } }), true);
  assert.deepEqual(lookup("s", dir, "k"), { necessary: { p: 0.5 } });
});

test("pipeline: a plain edit is judged and allowed; a read is skipped without a Jev call; the ledger and log record both", async () => {
  const dir = fresh(); const logPath = join(dir, "decisions.jsonl");
  const provider = mockProvider();
  recordPrompt(sid, "로그인 버그만 고쳐. DB는 건드리지 마.", { dir });
  const edit = await assess(act("Edit", { file_path: "src/auth.py", old_string: "a", new_string: "b" }, { id: "e1" }), { provider, dir, logPath, env: {} });
  assert.equal(edit.decision, "ALLOW"); assert.equal(edit.judged, true); assert.equal(edit.emit, null); assert.equal(edit.advisory, null);
  const read = await assess(act("Read", { file_path: "src/auth.py" }, { id: "r1" }), { provider, dir, logPath, env: {} });
  assert.equal(read.decision, "SKIP"); assert.equal(read.judged, false);
  const entries = replay(readEvents(sid, dir)).entries;
  assert.deepEqual(entries.map((e) => [e.tool, e.decision, e.judged, e.exec]), [["Edit", "ALLOW", true, "running"], ["Read", "SKIP", false, "running"]]);
  const log = logLines(logPath);
  assert.equal(log.length, 2);
  assert.equal(log[0].provider, "mock"); assert.equal(log[1].why, "read");
  assert.ok(!JSON.stringify(log).includes("old_string"), "the log never carries tool input bodies");
});

test("pipeline: a repeated read in the same turn is judged; in shadow mode the advisory is logged, not emitted; in advise mode it is emitted once", async () => {
  const dir = fresh(); const logPath = join(dir, "decisions.jsonl");
  const provider = mockProvider();   // a read that already passed with nothing changed is the redundant rule, which outranks necessary
  recordPrompt(sid, "fix the login bug", { dir });
  const input = { file_path: "src/auth.py" };
  const body = "def login():\n    pass\n".repeat(300);   // re-reading it costs context: what makes a repeat worth a line
  await assess(act("Read", input, { id: "r1" }), { provider, dir, logPath, env: {} });
  recordResult(sid, { toolUseId: "r1", tool: "Read", input, output: body }, { dir });
  const shadow = await assess(act("Read", input, { id: "r2" }), { provider, dir, logPath, env: {} });
  assert.equal(shadow.judged, true); assert.equal(shadow.advisory.rule, "redundant"); assert.equal(shadow.emit, null);
  recordResult(sid, { toolUseId: "r2", tool: "Read", input, output: body }, { dir });
  const advise = await assess(act("Read", input, { id: "r3" }), { provider, dir, logPath, env: { JEV_SAVE_MODE: "advise" } });
  assert.equal(advise.emit.kind, "context");
  assert.match(advise.emit.text, /#2 ran this and passed; nothing changed since/);   // the most recent pass (r2), not the first
  recordResult(sid, { toolUseId: "r3", tool: "Read", input, output: body }, { dir });
  const again = await assess(act("Read", input, { id: "r4" }), { provider, dir, logPath, env: { JEV_SAVE_MODE: "advise" } });
  assert.equal(again.emit, null, "a cooldown per action");
  assert.equal(again.advisory.suppressed, true);
  const log = logLines(logPath);
  assert.deepEqual(log.map((l) => l.emitted ?? null), [null, null, "context", null]);
});

test("pipeline: scope expansion on an edit is an advisory, never a block; security deny is a block only in advise mode", async () => {
  const dir = fresh(); const logPath = join(dir, "decisions.jsonl");
  const provider = mockProvider();
  recordPrompt(sid, "로그인 버그만 고쳐. DB는 건드리지 마.", { dir });
  const mig = act("Write", { file_path: "db/migrations/0002_add_table.py", content: "migration" }, { id: "w1" });
  const shadow = await assess(mig, { provider, dir, logPath, env: {} });
  assert.equal(shadow.decision, "ALLOW"); assert.equal(shadow.advisory.rule, "scope"); assert.equal(shadow.emit, null);
  const advise = await assess(mig, { provider, dir, logPath, env: { JEV_SAVE_MODE: "advise" } });
  assert.equal(advise.emit.kind, "context"); assert.match(advise.emit.text, /outside the request/);
  const rm = act("Bash", { command: "rm -rf /" }, { id: "b1" });
  assert.equal((await assess(rm, { provider, dir, logPath, env: {} })).emit, null);
  const denied = await assess(rm, { provider, dir, logPath, env: { JEV_SAVE_MODE: "advise" } });
  assert.equal(denied.decision, "DENY"); assert.equal(denied.emit.kind, "deny");
  assert.equal(replay(readEvents(sid, dir)).entries.at(-1).exec, "blocked");
  const noSec = await assess(rm, { provider, dir, logPath, env: { JEV_SAVE_MODE: "advise", JEV_SAVE_SECURITY: "0" } });
  assert.equal(noSec.decision, "ALLOW");
  const logged = await assess(act("Bash", { command: "rm -rf /" }, { id: "b2" }), { provider, dir, logPath, env: { JEV_SAVE_MODE: "advise", JEV_SAVE_SECURITY: "log" } });
  assert.equal(logged.decision, "ALLOW"); assert.equal(logged.emit, null, "security=log never blocks");
  assert.ok(logLines(logPath).at(-1).fired.includes("security:risk:logged"));
  assert.equal(replay(readEvents(sid, dir)).entries.at(-1).exec, "running");
});

test("pipeline: redundant check after a pass with no change is an advisory; after an edit it is not", async () => {
  const dir = fresh(); const logPath = join(dir, "decisions.jsonl");
  const provider = mockProvider();
  recordPrompt(sid, "fix the login bug", { dir });
  const input = { command: "pytest tests/test_auth.py -q" };
  await assess(act("Bash", input, { id: "c1" }), { provider, dir, logPath, env: {} });
  recordResult(sid, { toolUseId: "c1", tool: "Bash", input, output: "===== 5 passed in 6.3s =====", durationMs: 6300 }, { dir });
  const rep = await assess(act("Bash", { command: "pytest tests/test_auth.py -q 2>&1 | tail -3" }, { id: "c2" }), { provider, dir, logPath, env: { JEV_SAVE_MODE: "advise" } });
  assert.equal(rep.advisory.rule, "redundant", "another pipe on the same producer is the same action");
  assert.match(rep.emit.text, /#1 ran this \(6 s\) and passed; nothing changed since\. If you need another part of its output, save it once/);
  recordResult(sid, { toolUseId: "c2", tool: "Bash", input, output: "===== 5 passed in 6.3s =====", durationMs: 6300 }, { dir });
  await assess(act("Edit", { file_path: "src/auth.py", old_string: "a", new_string: "b" }, { id: "e1" }), { provider, dir, logPath, env: {} });
  recordResult(sid, { toolUseId: "e1", tool: "Edit", input: { file_path: "src/auth.py" } }, { dir });
  const after = await assess(act("Bash", input, { id: "c3" }), { provider, dir, logPath, env: { JEV_SAVE_MODE: "advise" } });
  assert.notEqual(after.advisory?.rule, "redundant");
  assert.equal(after.emit, null);
});

test("a project under the home directory keeps its validity: redacted display path vs raw path never compared (review P2)", async () => {
  const dir = fresh(); const logPath = join(dir, "decisions.jsonl");
  const provider = mockProvider();
  const home = "/home/u"; const cwd = "/home/u/proj";
  recordPrompt(sid, "fix the login bug", { dir, home });
  const input = { command: "pytest tests/test_auth.py -q" };
  await assess(act("Bash", input, { id: "c1", cwd }), { provider, dir, logPath, env: {}, home });
  recordResult(sid, { toolUseId: "c1", tool: "Bash", input, output: "===== 5 passed in 6.3s =====", hostSuccess: true, durationMs: 6300 }, { dir });
  const entry = replay(readEvents(sid, dir)).entries[0];
  assert.equal(entry.cwd, "~/proj", "displayed redacted");
  assert.equal(entry.cwd_id, cwdIdOf(cwd), "compared by identity");
  const rep = await assess(act("Bash", input, { id: "c2", cwd }), { provider, dir, logPath, env: { JEV_SAVE_MODE: "advise" }, home });
  assert.equal(rep.advisory?.rule, "redundant");
  assert.equal(rep.emit.kind, "context");
  const elsewhere = await assess(act("Bash", input, { id: "c3", cwd: "/home/u/other" }), { provider, dir, logPath, env: { JEV_SAVE_MODE: "advise" }, home });
  assert.notEqual(elsewhere.advisory?.rule, "redundant", "a different directory is not the same evidence");
});

test("recordResult: outcomes from the runner output, failures and interrupts; unknown ids are ignored", () => {
  const dir = fresh();
  recordPrompt(sid, "x", { dir });
  assert.equal(recordResult(sid, { toolUseId: "", tool: "Bash" }, { dir }), null);
  assert.deepEqual(recordResult(sid, { toolUseId: "a", tool: "Bash", input: { command: "pytest" }, output: "===== 1 failed, 2 passed in 1.0s =====" }, { dir }), { kind: "check", result: "fail", exec: "completed" });
  assert.deepEqual(recordResult(sid, { toolUseId: "b", tool: "Bash", input: { command: "pytest" }, failed: true, output: "Exit code 1" }, { dir }), { kind: "check", result: "fail", exec: "failed" });
  assert.deepEqual(recordResult(sid, { toolUseId: "c", tool: "Bash", input: { command: "pytest" }, interrupted: true }, { dir }), { kind: "check", result: "unknown", exec: "failed" });
  assert.deepEqual(recordResult(sid, { toolUseId: "d", tool: "Edit", input: { file_path: "a" } }, { dir }), { kind: "edit", result: "pass", exec: "completed" });
  assert.deepEqual(recordResult(sid, { toolUseId: "e", tool: "Bash", input: { command: "npm test" }, output: "npm ERR! Missing script: \"test\"" }, { dir }), { kind: "check", result: "unknown", exec: "completed" }, "Codex-style: no exit status, no summary");
  assert.deepEqual(recordResult(sid, { toolUseId: "f", tool: "Bash", input: { command: "npm test" }, output: "", hostSuccess: true }, { dir }), { kind: "check", result: "pass", exec: "completed" });
});

test("the Jev provider records the model version the alias resolved to, and the guard logs it per decision", async () => {
  const { jevProvider } = await import("../src/providers/jev.js");
  const fetchImpl = async () => ({ ok: true, json: async () => ({ model: "jev-9.9.9", answers: { necessary: { type: "noul", noul: 0.9 }, in_scope: { type: "noul", noul: 0.9 }, redundant: { type: "noul", noul: 0.1 }, scope_expansion: { type: "noul", noul: 0.1 }, kind: { type: "choice", choice: "progress", probabilities: {}, confidence: 0.9 } }, usage: { input_tokens: 5 } }) });
  const provider = jevProvider({ fetchImpl });
  const dir = fresh(); const logPath = join(dir, "decisions.jsonl");
  recordPrompt(sid, "x", { dir });
  const r = await assess(act("Edit", { file_path: "a.py", old_string: "a", new_string: "b" }, { id: "e1" }), { provider, dir, logPath, env: { JEV_API_KEY: "test", JEV_SAVE_SECURITY: "0" } });
  assert.equal(r.decision, "ALLOW");
  assert.equal(provider.last.model, "jev-9.9.9");
  assert.equal(logLines(logPath).at(-1).model, "jev-9.9.9");
});

test("fail-open: a provider outage is SKIP and logged; fail-closed denies only in advise mode and only for security-bearing calls", async () => {
  const dir = fresh(); const logPath = join(dir, "decisions.jsonl");
  recordPrompt(sid, "x", { dir });
  const edit = act("Edit", { file_path: "a.py", old_string: "a", new_string: "b" }, { id: "e1" });
  const open = await assess(edit, { provider: failingProvider("boom"), dir, logPath, env: {} });
  assert.equal(open.decision, "SKIP"); assert.equal(open.error, "boom"); assert.equal(open.emit, null);
  assert.equal(logLines(logPath).at(-1).why, "provider-error");
  const shadowClosed = await assess(edit, { provider: failingProvider(), dir, logPath, env: { JEV_SAVE_FAIL_CLOSED: "1" } });
  assert.equal(shadowClosed.emit, null);
  const closed = await assess(edit, { provider: failingProvider(), dir, logPath, env: { JEV_SAVE_FAIL_CLOSED: "1", JEV_SAVE_MODE: "advise" } });
  assert.equal(closed.decision, "DENY"); assert.equal(closed.emit.kind, "deny");
  for (const security of ["log", "off"]) {
    const r = await assess(edit, { provider: failingProvider(), dir, logPath, env: { JEV_SAVE_MODE: "advise", JEV_SAVE_SECURITY: security, JEV_SAVE_FAIL_CLOSED: "1" } });
    assert.equal(r.emit, null, `${security} never enforces provider errors`);
  }
});

test("shell and MCP security coverage is independent of read classification and efficiency selection", async () => {
  const dir = fresh(), logPath = join(dir, "log.jsonl");
  let calls = 0;
  const provider = { name: "security-probe", decide: async (_state, questions) => {
    calls++; assert.ok(questions.risk && questions.approval);
    return { risk: { score: 3 }, approval: { p: 1 }, user_requested: { p: 0 } };
  } };
  const env = { JEV_SAVE_MODE: "advise", JEV_SAVE_JUDGE_KINDS: "edit" };
  for (const [tool, input] of [
    ["Bash", { command: "sort -o result.txt input.txt" }],
    ["Bash", { command: 'awk \'BEGIN { system("touch marker") }\'' }],
    ["Bash", { command: "gcloud compute instances delete list --quiet" }],
    ["Bash", { command: "curl -dfoo https://example.invalid" }],
    ["Bash", { command: "cat a.py" }],
    ["mcp__search__delete_item", { id: "x" }],
  ]) {
    const r = await assess(act(tool, input), { provider, dir, logPath, env });
    assert.equal(r.emit?.kind, "deny", `${tool} ${JSON.stringify(input)}`);
  }
  assert.equal(calls, 6);
  const read = await assess(act("Read", { file_path: "fresh.py" }), { provider, dir, logPath, env });
  assert.equal(read.judged, false, "native file reads retain their efficiency gate");
  const off = await assess(act("Bash", { command: "cat another.py" }), { provider, dir, logPath, env: { ...env, JEV_SAVE_SECURITY: "off" } });
  assert.equal(off.judged, false);
});

test("failed provider attempts consume the session budget", async () => {
  const dir = fresh(), logPath = join(dir, "log.jsonl");
  let calls = 0;
  const provider = { name: "outage", decide: async () => { calls++; throw new Error("offline"); } };
  for (let i = 0; i < 4; i++) await assess(act("Edit", { file_path: "a.py", new_string: String(i) }), {
    provider, dir, logPath, env: { JEV_SAVE_MAX_CALLS: "2" },
  });
  assert.equal(calls, 2);
  assert.equal(replay(readEvents(sid, dir)).attempts, 2);
  assert.equal(logLines(logPath).at(-1).why, "budget");
});

test("budget: past JEV_SAVE_MAX_CALLS nothing is judged; the cache answers an exact retry without a provider call", async () => {
  const dir = fresh(); const logPath = join(dir, "decisions.jsonl");
  let calls = 0;
  const provider = { name: "counting", decide: async (...a) => { calls++; return mockProvider().decide(...a); } };
  recordPrompt(sid, "x", { dir });
  const edit = act("Edit", { file_path: "a.py", old_string: "a", new_string: "b" }, { id: "e1" });
  await assess(edit, { provider, dir, logPath, env: {} });
  const hit = await assess(edit, { provider, dir, logPath, env: {} });   // same state (the ledger view hasn't changed in a way the state shows? it has: recent_tool_calls grew)
  assert.equal(calls, 2, "a changed ledger is a different state");
  assert.equal(hit.cached, false);
  const capped = await assess(act("Edit", { file_path: "b.py", old_string: "a", new_string: "b" }, { id: "e3" }), { provider, dir, logPath, env: { JEV_SAVE_MAX_CALLS: "2" } });
  assert.equal(capped.decision, "SKIP"); assert.equal(calls, 2);
  assert.equal(logLines(logPath).at(-1).why, "budget");
});

// A Claude Code transcript: one JSON line per message, tool_use blocks in assistant lines, tool_result blocks in user lines.
const transcriptLine = (type, content) => JSON.stringify({ type, message: { role: type, content } }) + "\n";
const said = (text) => transcriptLine("assistant", [{ type: "text", text }]);
const used = (id, command) => transcriptLine("assistant", [{ type: "tool_use", id, name: "Bash", input: { command } }]);
const resulted = (id, content, is_error = false) => transcriptLine("user", [{ type: "tool_result", tool_use_id: id, content, is_error }]);
const DENIAL = "Permission to use Bash has been denied because Claude Code is running in don't ask mode. IMPORTANT: You *may* attempt to accomplish this action using other tools";

test("transcript: the tail parser finds the agent's last words and every tool_result, and knows a denial when it sees one", () => {
  const text = said("Let me run the plan.") + used("t1", "terraform plan") + resulted("t1", "No changes.") + said("The grep came back empty, which is odd.") + used("t2", "terraform plan > out") + resulted("t2", DENIAL, true) + resulted("t3", [{ type: "text", text: "Error: boom" }], true) + "{not json";
  const { narration, results } = parseTail(text);
  assert.equal(narration, "The grep came back empty, which is odd.");
  assert.deepEqual([...results.keys()], ["t1", "t2", "t3"]);
  assert.deepEqual(results.get("t1"), { error: false, denied: false, output: "No changes." });
  assert.equal(results.get("t2").denied, true);
  assert.deepEqual(results.get("t3"), { error: true, denied: false, output: "Error: boom" });
  assert.equal(readTail("/nonexistent/transcript.jsonl"), "");
  const path = join(fresh(), "t.jsonl");
  writeFileSync(path, "x".repeat(100) + "\n" + said("late words"));
  assert.equal(parseTail(readTail(path, 120)).narration, "late words", "a tail cut mid-line starts at the next line");
  assert.equal(parseTail(readTail(path, 60)).narration, null, "a tail too short for the last line finds nothing rather than a broken line");
});

test("pipeline: a denied call learned from the transcript is not a run, so the next real run of the action is judged against the last pass", async () => {
  const dir = fresh(); const logPath = join(dir, "decisions.jsonl"); const transcriptPath = join(dir, "transcript.jsonl");
  const provider = mockProvider();
  recordPrompt(sid, "WEB 계층 드리프트 감사. apply 금지.", { dir });
  const plan = "terraform plan -input=false -no-color -lock=false";
  let transcript = said("Let me capture a plan.") + used("p1", `${plan} 2>&1 | tail -250`);
  writeFileSync(transcriptPath, transcript);
  await assess(act("Bash", { command: `${plan} 2>&1 | tail -250` }, { id: "p1", transcriptPath }), { provider, dir, logPath, env: { JEV_SAVE_MODE: "advise" } });
  recordResult(sid, { toolUseId: "p1", tool: "Bash", input: { command: `${plan} 2>&1 | tail -250` }, output: "No changes. Your infrastructure matches the configuration.", durationMs: 13800 }, { dir });
  // the agent tries to save the output to a file; dontAsk denies it and no PostToolUse ever fires
  transcript += resulted("p1", "No changes.") + said("The grep came back empty, which is odd. Let me capture the full plan output to a file.") + used("p2", `${plan} > .plan-audit.txt 2>&1`);
  writeFileSync(transcriptPath, transcript);
  const second = await assess(act("Bash", { command: `${plan} > .plan-audit.txt 2>&1` }, { id: "p2", transcriptPath }), { provider, dir, logPath, env: { JEV_SAVE_MODE: "advise" } });
  assert.equal(second.advisory.rule, "redundant"); assert.equal(second.advisory.suppressed, true, "'the grep came back empty' is a reason");
  transcript += resulted("p2", DENIAL, true) + said("Let me pull ALB attributes next.") + used("p3", `${plan} 2>&1 | grep -nE "No changes|^Plan:"`);
  writeFileSync(transcriptPath, transcript);
  const third = await assess(act("Bash", { command: `${plan} 2>&1 | grep -nE "No changes|^Plan:"` }, { id: "p3", transcriptPath }), { provider, dir, logPath, env: { JEV_SAVE_MODE: "advise" } });
  const entries = replay(readEvents(sid, dir)).entries;
  assert.equal(entries[1].exec, "blocked", "the denial closed p2 from the transcript");
  assert.equal(third.advisory.rule, "redundant");
  assert.equal(third.advisory.suppressed, false, "'pull ALB attributes' is no reason to re-run the plan");
  assert.match(third.emit.text, /#1 ran this \(14 s\) and passed; nothing changed since\. If you need another part of its output, save it once/);
  assert.equal(third.signals.expects_new_information, 0.1, "the stated-reason question was asked, because the action had run before");
  assert.equal(logLines(logPath).at(-1).view.reason, true);
});

test("pipeline: a stated reason lifts the redundant advisory; a third identical failure is called whatever was said", async () => {
  const dir = fresh(); const logPath = join(dir, "decisions.jsonl"); const transcriptPath = join(dir, "transcript.jsonl");
  const provider = mockProvider();
  recordPrompt(sid, "WEB 계층 드리프트 감사. apply 금지.", { dir });
  const plan = "terraform plan -input=false -no-color -lock=false";
  const run = async (id, pipe, narration, { output, durationMs = 14000, failed = false } = {}) => {
    writeFileSync(transcriptPath, said(narration) + used(id, `${plan} ${pipe}`));
    const r = await assess(act("Bash", { command: `${plan} ${pipe}` }, { id, transcriptPath }), { provider, dir, logPath, env: { JEV_SAVE_MODE: "advise" } });
    if (output !== undefined) recordResult(sid, { toolUseId: id, tool: "Bash", input: { command: `${plan} ${pipe}` }, output, durationMs, failed, hostSuccess: !failed }, { dir });
    return r;
  };
  await run("p1", "| tail -250", "Now let me capture a plan.", { output: "No changes. Your infrastructure matches the configuration." });
  const odd = await run("p2", "| tail -8", "The grep came back empty, which is odd. Let me capture the full plan output and inspect it directly.", { output: "No changes. Your infrastructure matches the configuration." });
  assert.equal(odd.advisory.rule, "redundant");
  assert.equal(odd.advisory.suppressed, true);
  assert.match(odd.advisory.why, /stated a reason/);
  assert.equal(odd.emit, null);
  const silent = await run("p3", "| grep -n Plan", "Let me look at the tags next.", { output: "No changes. Your infrastructure matches the configuration." });
  assert.equal(silent.emit?.kind, "context");
  // credentials expire: terraform fails behind `| tail`, which the parser sees where the exit status could not
  const failing = "Planning failed. Terraform encountered an error while generating this plan.\n\nError: Retrieving AWS account details: ExpiredToken\n\n  on providers.tf line 1, in provider \"aws\":";
  await run("p4", "| tail -15", "Credentials have expired. Let me try refreshing them.", { output: failing });
  assert.equal(replay(readEvents(sid, dir)).entries[3].result, "fail");
  const second = await run("p5", "| tail -20", "The default profile has valid credentials. Let me run plan using the profile.", { output: failing });
  assert.notEqual(second.advisory?.rule, "repeat-failure", "one retry is normal");
  const third = await run("p6", "| tail -12", "Now let me re-attempt the plan (env credentials may have refreshed).", { output: failing });
  assert.equal(third.advisory.rule, "repeat-failure");
  assert.equal(third.advisory.suppressed, false);
  assert.equal(third.emit.text, "jev-save: #4 and #5 ran this and failed; nothing changed since. Fix the cause before running it again.");
});

test("classifyPrompt: Jev's word on the message is recorded next to the prompt, with the assistant's previous message; synthetic prompts, a missing provider and an outage leave the prompt unclassified", async () => {
  const dir = fresh(); const logPath = join(dir, "decisions.jsonl"); const transcriptPath = join(dir, "t.jsonl");
  const provider = mockProvider();
  const { classifyPrompt } = await import("../src/core/guard.js");
  writeFileSync(transcriptPath, said("남은 일: 1) ALB 로그 2) 80 리다이렉트 3) 중지된 인스턴스 2대 종료. 진행할까요?"));
  let rec = recordPrompt(sid, "cloudwatch agent 설치 되어 있어?", { dir });
  assert.deepEqual(rec, { turn: 1, synthetic: false });
  assert.deepEqual(await classifyPrompt(sid, "cloudwatch agent 설치 되어 있어?", rec, { provider, transcriptPath, dir, logPath, env: {} }), { kind: "question", refers: 0.1 });
  rec = recordPrompt(sid, "부탁할게", { dir });
  assert.deepEqual(await classifyPrompt(sid, "부탁할게", rec, { provider, transcriptPath, dir, logPath, env: {} }), { kind: "approval", refers: 0.9 });
  const st = replay(readEvents(sid, dir));
  assert.equal(st.request.source, "approval@2");
  assert.match(st.request.text, /인스턴스 2대 종료/);
  assert.equal(view(st, { digest: "d", cwdId: cwdIdOf("/repo") }).original_request, st.request.text);
  // synthetic: recorded, never classified
  rec = recordPrompt(sid, "<bash-input>npm test</bash-input>", { dir });
  assert.equal(rec.synthetic, true);
  assert.equal(await classifyPrompt(sid, "<bash-input>npm test</bash-input>", rec, { provider, transcriptPath, dir, logPath, env: {} }), null);
  // no provider, then an outage: the prompt stands, the request does not move
  rec = recordPrompt(sid, "DB는 건드리지 마", { dir });
  assert.equal(await classifyPrompt(sid, "DB는 건드리지 마", rec, { transcriptPath, dir, logPath, env: {} }), null);
  rec = recordPrompt(sid, "auth만 봐", { dir });
  assert.equal(await classifyPrompt(sid, "auth만 봐", rec, { provider: failingProvider(), transcriptPath, dir, logPath, env: {} }), null);
  assert.equal(replay(readEvents(sid, dir)).request.source, "approval@2");
  const log = logLines(logPath);
  assert.deepEqual(log.map((l) => [l.event, l.kind ?? l.why]), [["prompt", "question"], ["prompt", "approval"], ["prompt", "provider-error"]]);
  assert.ok(!JSON.stringify(log).includes("인스턴스"), "the log carries the kind, not the texts");
  // the classification counts against the session budget like any other provider call
  assert.equal(replay(readEvents(sid, dir)).attempts, 3);
});

test("pipeline: scope is judged against the tracked request — an approved proposal makes the proposed call in scope", async () => {
  const dir = fresh(); const logPath = join(dir, "decisions.jsonl"); const transcriptPath = join(dir, "t.jsonl");
  const { classifyPrompt } = await import("../src/core/guard.js");
  // a provider whose scope answers depend on the request text it is shown, the way Jev's did on the trial
  const provider = mockProvider({ rules: {
    scope_expansion: (state) => (/terminate/.test(JSON.stringify(state.input)) && !/인스턴스 2대 종료/.test(state.context?.original_request ?? "") ? 0.9 : 0.05),
    in_scope: (state, a) => 1 - a.scope_expansion,
  } });
  writeFileSync(transcriptPath, said("cloudwatch 는 설치되어 있습니다."));
  let rec = recordPrompt(sid, "cloudwatch agent 설치 되어 있어?", { dir });
  await classifyPrompt(sid, "cloudwatch agent 설치 되어 있어?", rec, { provider, transcriptPath, dir, logPath, env: {} });
  const cmd = { command: "aws ec2 terminate-instances --instance-ids i-1 i-2" };
  const before = await assess(act("Bash", cmd, { id: "t1" }), { provider, dir, logPath, env: { JEV_SAVE_MODE: "advise", JEV_SAVE_SECURITY: "off" } });
  assert.equal(before.advisory?.rule, "scope", "against the first prompt the termination is off-request");
  writeFileSync(transcriptPath, said("cloudwatch 는 설치되어 있습니다.") + said("남은 일: 1) ALB 로그 2) 80 리다이렉트 3) 중지된 인스턴스 2대 종료. 진행할까요?"));
  rec = recordPrompt(sid, "부탁할게", { dir });
  await classifyPrompt(sid, "부탁할게", rec, { provider, transcriptPath, dir, logPath, env: {} });
  const after = await assess(act("Bash", cmd, { id: "t2" }), { provider, dir, logPath, env: { JEV_SAVE_MODE: "advise", JEV_SAVE_SECURITY: "off" } });
  assert.equal(after.advisory, null, "against the approved proposal it is the request");
  assert.equal(logLines(logPath).at(-1).view.request, "approval@2");
});
