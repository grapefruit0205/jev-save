import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assess, recordPrompt, recordResult, settings, shouldJudge } from "../src/core/guard.js";
import { buildState, projectInput } from "../src/core/context.js";
import { append, cwdIdOf, history, readEvents, replay, view } from "../src/core/ledger.js";
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

test("buildState sends the conversation as history, the proposed call as one line, and the ledger's facts", () => {
  const dir = fresh();
  recordPrompt(sid, "로그인 버그만 고쳐. DB는 건드리지 마.", { dir });
  const state = replay(readEvents(sid, dir));
  const v = view(state, { digest: "d", cwdId: cwdIdOf("/repo") });
  const st = buildState(act("Bash", { command: "pytest -q" }), { kind: "check", runner: "test" }, v, { home: "/home/u", history: history(state) });
  assert.deepEqual(st.context.history, ["user: 로그인 버그만 고쳐. DB는 건드리지 마."]);
  assert.equal(st.context.proposed_call, "Bash pytest -q");
  assert.equal(st.context.proposed_call_kind, "check (test)");
  assert.deepEqual(st.context.facts, { same_action_runs_since_last_user_message: 0, last_outcome_of_this_action: "never ran", changed_since_last_pass: [], validity_of_last_pass: "none" });
  assert.deepEqual(st.context.user_recent_messages, ["로그인 버그만 고쳐. DB는 건드리지 마."], "jev-guard's security questions still read this");
  assert.equal(st.tool, "Bash");
  assert.deepEqual(st.input, { command: "pytest -q" });
  assert.equal(st.context.session_started_with, undefined, "nothing dropped, so no separate first request");
});

test("history: user words verbatim and agent actions one line each, in order; synthetic prompts left out; tail-capped with the first request kept", () => {
  const dir = fresh();
  recordPrompt(sid, "테스트 파일은 건드리지 마.", { dir });
  append(sid, { ev: "pre", turn: 1, tool_use_id: "a1", tool: "Edit", kind: "edit", digest: "d1", preview: "src/auth.py", paths: ["src/auth.py"], cwd: "/repo", exec: "running" }, { dir });
  append(sid, { ev: "post", tool_use_id: "a1", exec: "completed", result: "pass" }, { dir });
  recordPrompt(sid, "<bash-input>npm test</bash-input><bash-stdout>ok</bash-stdout>", { dir });
  recordPrompt(sid, "아 이제 테스트 파일 수정해도 돼.", { dir });
  append(sid, { ev: "pre", turn: 3, tool_use_id: "a2", tool: "Bash", kind: "check", digest: "d2", preview: "pytest -q", paths: [], cwd: "/repo", exec: "running" }, { dir });
  const h = history(replay(readEvents(sid, dir)));
  assert.deepEqual(h.lines, ["user: 테스트 파일은 건드리지 마.", "agent: Edit src/auth.py -> pass", "user: 아 이제 테스트 파일 수정해도 돼.", "agent: Bash pytest -q"]);
  assert.equal(h.dropped, 0);
  const capped = history(replay(readEvents(sid, dir)), { maxChars: 60 });
  assert.ok(capped.dropped > 0 && capped.lines.length < 4);
  assert.equal(capped.first_request, "테스트 파일은 건드리지 마.", "the opening request survives a cap separately");
  assert.equal(capped.lines.at(-1), "agent: Bash pytest -q", "the newest lines are the ones kept");
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
  const provider = mockProvider();   // a read that already passed since the user last spoke, nothing changed: the redundant fact
  recordPrompt(sid, "fix the login bug", { dir });
  const input = { file_path: "src/auth.py" };
  await assess(act("Read", input, { id: "r1" }), { provider, dir, logPath, env: {} });
  recordResult(sid, { toolUseId: "r1", tool: "Read", input }, { dir });
  const shadow = await assess(act("Read", input, { id: "r2" }), { provider, dir, logPath, env: {} });
  assert.equal(shadow.judged, true); assert.equal(shadow.advisory.rule, "redundant"); assert.equal(shadow.emit, null);
  recordResult(sid, { toolUseId: "r2", tool: "Read", input }, { dir });
  const advise = await assess(act("Read", input, { id: "r3" }), { provider, dir, logPath, env: { JEV_SAVE_MODE: "advise" } });
  assert.equal(advise.emit.kind, "context");
  assert.match(advise.emit.text, /#2 already ran this and passed since the user's last message/);
  recordResult(sid, { toolUseId: "r3", tool: "Read", input }, { dir });
  const again = await assess(act("Read", input, { id: "r4" }), { provider, dir, logPath, env: { JEV_SAVE_MODE: "advise" } });
  assert.equal(again.emit, null, "once per action per turn");
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
  assert.equal(shadow.decision, "ALLOW"); assert.equal(shadow.advisory.rule, "forbidden", "the user said DB는 건드리지 마 and this touches db/"); assert.equal(shadow.emit, null);
  const advise = await assess(mig, { provider, dir, logPath, env: { JEV_SAVE_MODE: "advise" } });
  assert.equal(advise.emit.kind, "context"); assert.match(advise.emit.text, /the user said not to do this/);
  // scope without a prohibition: an unrelated refactor under a narrow request
  const refactor = act("Edit", { file_path: "src/billing/invoice.py", old_string: "class InvoiceBuilder", new_string: "class AbstractInvoiceFactory" }, { id: "w2" });
  const sc = await assess(refactor, { provider, dir, logPath, env: { JEV_SAVE_MODE: "advise", JEV_SAVE_COOLDOWN_CALLS: "0" } });   // the previous advisory was one call ago
  assert.equal(sc.advisory.rule, "scope"); assert.match(sc.emit.text, /outside what the user asked for/);
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
  recordResult(sid, { toolUseId: "c1", tool: "Bash", input, output: "===== 5 passed in 0.3s =====" }, { dir });
  const rep = await assess(act("Bash", input, { id: "c2" }), { provider, dir, logPath, env: { JEV_SAVE_MODE: "advise" } });
  assert.equal(rep.advisory.rule, "redundant"); assert.match(rep.emit.text, /#1 already ran this and passed/);
  recordResult(sid, { toolUseId: "c2", tool: "Bash", input, output: "===== 5 passed in 0.3s =====" }, { dir });
  await assess(act("Edit", { file_path: "src/auth.py", old_string: "a", new_string: "b" }, { id: "e1" }), { provider, dir, logPath, env: {} });
  recordResult(sid, { toolUseId: "e1", tool: "Edit", input: { file_path: "src/auth.py" } }, { dir });
  const after = await assess(act("Bash", input, { id: "c3" }), { provider, dir, logPath, env: { JEV_SAVE_MODE: "advise" } });
  assert.notEqual(after.advisory?.rule, "redundant");
  assert.equal(after.emit, null);
});

test("pipeline: a prohibition later lifted by the user is honoured — the model reads the words, no rule engine", async () => {
  const dir = fresh(); const logPath = join(dir, "decisions.jsonl");
  const provider = mockProvider();
  recordPrompt(sid, "tests/ 폴더는 건드리지 마.", { dir });
  const edit = act("Edit", { file_path: "tests/test_auth.py", old_string: "a", new_string: "b" }, { id: "e1" });
  const before = await assess(edit, { provider, dir, logPath, env: { JEV_SAVE_MODE: "advise" } });
  assert.equal(before.advisory?.rule, "forbidden");
  recordPrompt(sid, "아 이제 tests/ 수정해도 돼.", { dir });
  const after = await assess(act("Edit", { file_path: "tests/test_auth.py", old_string: "a", new_string: "c" }, { id: "e2" }), { provider, dir, logPath, env: { JEV_SAVE_MODE: "advise" } });
  assert.equal(after.advisory, null);
  assert.equal(after.emit, null);
});

test("a project under the home directory keeps its validity: redacted display path vs raw path never compared (review P2)", async () => {
  const dir = fresh(); const logPath = join(dir, "decisions.jsonl");
  const provider = mockProvider();
  const home = "/home/u"; const cwd = "/home/u/proj";
  recordPrompt(sid, "fix the login bug", { dir, home });
  const input = { command: "pytest tests/test_auth.py -q" };
  await assess(act("Bash", input, { id: "c1", cwd }), { provider, dir, logPath, env: {}, home });
  recordResult(sid, { toolUseId: "c1", tool: "Bash", input, output: "===== 5 passed in 0.3s =====", hostSuccess: true }, { dir });
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
