import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, thresholds } from "../src/core/policy.js";
import { bundle, EFFICIENCY_QUESTIONS } from "../src/core/questions.js";

const t = thresholds({});
const baseView = {
  turn: 1, original_request: "로그인 버그만 고쳐. DB는 건드리지 마.", recent_instructions: [], recent: [],
  calls_this_turn: 3, kinds_this_turn: { read: 2, search: 1, check: 0, edit: 0 },
  same_action_count_this_turn: 0, last_outcome_of_this_action: null, last_run_same_input: null, last_duration_ms: null, last_output_chars: null, failed_runs: [],
  last_pass_seq: null, changed_since_last_pass: [], unknown_since_last_pass: false, validity: "none",
  jev_calls: 0, advisories_this_turn: 0, advisories_in_window: 0, advisories_for_this_action_this_turn: 0, advised_for_this_action: [], calls_since_last_advisory: Infinity,
};
const view = (o = {}) => ({ ...baseView, ...o });
const eff = (o = {}) => ({ in_scope: { p: 0.95 }, necessary: { p: 0.9 }, scope_expansion: { p: 0.05 }, kind: { choice: "progress" }, ...o });
const sec = (score, approval = 0.05) => ({ risk: { score }, approval: { p: approval }, user_requested: { p: 0.05 } });
// a repeat of a passing, still-valid run that cost something: the redundant rule's whole condition
const repeatOf = (o = {}) => view({ validity: "valid", last_pass_seq: 12, same_action_count_this_turn: 1, last_outcome_of_this_action: "pass", last_run_same_input: true, last_duration_ms: 14000, last_output_chars: 9000, ...o });

test("the bundle carries the efficiency ids and, on request, jev-guard's security ids minus from_untrusted and the stated-reason question", () => {
  assert.deepEqual(Object.keys(bundle({ security: false })), Object.keys(EFFICIENCY_QUESTIONS));
  assert.ok(!("redundant" in EFFICIENCY_QUESTIONS), "v2: the repeat rules read the ledger, not Jev");
  const withSec = bundle({ security: true });
  assert.ok(withSec.risk && withSec.approval && withSec.user_requested && !withSec.from_untrusted);
  assert.ok(bundle({ security: true, untrusted: true }).from_untrusted);
  assert.ok(!bundle().expects_new_information && bundle({ reason: true }).expects_new_information);
  for (const q of Object.values(bundle({ security: true, reason: true }))) assert.ok(["noul", "choice", "score"].includes(q.type) && q.instructions.length > 20);
});

test("a clean call is ALLOW with no advisory", () => {
  const r = decide(eff(), view(), { kind: "edit" }, t);
  assert.equal(r.decision, "ALLOW");
  assert.equal(r.advisory, null);
  assert.deepEqual(r.fired, []);
  assert.equal(r.signals.necessary, 0.9);
  assert.equal(r.signals.kind, "progress");
});

test("security first: high risk denies, mid risk asks, and the user's explicit request lifts ask (never deny)", () => {
  assert.equal(decide({ ...eff(), ...sec(2.9) }, view(), { kind: "write-bash" }, t).decision, "DENY");
  const ask = decide({ ...eff(), ...sec(2.0, 0.8) }, view(), { kind: "write-bash" }, t);
  assert.equal(ask.decision, "ASK");
  assert.match(ask.reason, /approval/);
  // approval alone at a low risk score is not an ask: the scope advisory owns that case (measured live: an
  // off-request edit scored approval 0.84–0.95 at risk 1.0)
  const approvalOnly = decide({ ...eff({ scope_expansion: { p: 0.91 } }), ...sec(1.0, 0.9) }, view(), { kind: "edit" }, t);
  assert.equal(approvalOnly.decision, "ALLOW");
  assert.deepEqual(approvalOnly.fired, ["security:approval-only", "scope"]);
  assert.equal(approvalOnly.advisory.rule, "scope");
  assert.equal(decide({ ...eff(), ...sec(1.0, 0.9) }, view(), { kind: "edit" }, t).advisory, null);
  assert.equal(decide({ ...eff(), ...sec(2.0, 0.8), user_requested: { p: 0.95 } }, view(), { kind: "write-bash" }, t).decision, "ALLOW");
  assert.equal(decide({ ...eff(), ...sec(2.9), user_requested: { p: 0.99 } }, view(), { kind: "write-bash" }, t).decision, "DENY");
  const untrusted = decide({ ...eff(), ...sec(0.2), from_untrusted: { p: 0.9 } }, view(), { kind: "write-bash" }, t);
  assert.equal(untrusted.decision, "DENY");
  assert.deepEqual(untrusted.fired, ["security:untrusted"]);
  // without the security answers, the security rules are silent
  assert.equal(decide(eff(), view(), { kind: "write-bash" }, t).decision, "ALLOW");
});

test("security in log mode is recorded, never returned, and the advisories still run", () => {
  const r = decide({ ...eff({ scope_expansion: { p: 0.95 } }), ...sec(2.9) }, view(), { kind: "write-bash" }, t, { securityMode: "log" });
  assert.equal(r.decision, "ALLOW");
  assert.deepEqual(r.fired, ["security:risk:logged", "scope"]);
  assert.equal(r.advisory.rule, "scope");
  const a = decide({ ...eff(), ...sec(2.0, 0.8) }, view(), { kind: "write-bash" }, t, { securityMode: "log" });
  assert.equal(a.decision, "ALLOW");
  assert.deepEqual(a.fired, ["security:ask:logged"]);
  assert.equal(decide({ ...eff(), ...sec(2.9) }, view(), { kind: "write-bash" }, t, { securityMode: "on" }).decision, "DENY");
});

test("scope advisory: expansion or a low in_scope, quoting the request", () => {
  const r = decide(eff({ scope_expansion: { p: 0.91 }, in_scope: { p: 0.3 } }), view(), { kind: "edit" }, t);
  assert.equal(r.decision, "ALLOW");
  assert.equal(r.advisory.rule, "scope");
  assert.equal(r.advisory.suppressed, false);
  assert.match(r.advisory.text, /outside the request «로그인 버그만 고쳐/);
  assert.match(r.advisory.text, /p=0\.91/);
  assert.equal(decide(eff({ in_scope: { p: 0.1 }, scope_expansion: { p: 0.6 } }), view(), { kind: "edit" }, t).advisory.rule, "scope");
  assert.equal(decide(eff({ in_scope: { p: 0.1 }, scope_expansion: { p: 0.18 } }), view(), { kind: "edit" }, t).advisory, null, "the two signals disagree: not a scope case");
  assert.equal(decide(eff({ scope_expansion: { p: 0.84 }, in_scope: { p: 0.16 } }), view(), { kind: "edit" }, t).advisory, null);
  assert.equal(decide(eff({ scope_expansion: { p: 0.97 } }), view({ original_request: null }), { kind: "edit" }, t).advisory, null, "no request, no scope judgment");
  // a forbidden action rather than an added one: off-request and needing approval (a commit against "no commits"
  // measured in_scope 0.04 / approval 0.96 / expansion 0.44 on the headless trial)
  const forbidden = decide({ ...eff({ in_scope: { p: 0.04 }, scope_expansion: { p: 0.44 } }), ...sec(1.02, 0.96) }, view(), { kind: "vcs" }, t);
  assert.equal(forbidden.advisory.rule, "scope");
  assert.match(forbidden.advisory.text, /p=0\.96/);
  assert.equal(decide({ ...eff({ in_scope: { p: 0.13 }, scope_expansion: { p: 0.43 } }), ...sec(1.4, 0.85) }, view(), { kind: "write-bash" }, t).advisory, null, "approval 0.85 (the user-authorized terminate-instances) stays below the clause");
  assert.equal(decide({ ...eff({ in_scope: { p: 0.3 }, scope_expansion: { p: 0.2 } }), ...sec(1.0, 0.95) }, view(), { kind: "edit" }, t).advisory, null, "approval alone is not scope: in_scope must be low too");
});

test("redundant: the ledger's facts alone — a still-valid pass of the same action that cost time or context", () => {
  const valid = decide(eff({ necessary: { p: 0.1 } }), repeatOf(), { kind: "check" }, t);
  assert.equal(valid.advisory.rule, "redundant");
  assert.equal(valid.advisory.suppressed, false);
  assert.match(valid.advisory.text, /#12 ran this \(14 s\) and passed; nothing changed since\. Skip it/);
  assert.equal(valid.decisionMargin, 1, "a fact, not a probability");
  const otherPipe = decide(eff(), repeatOf({ last_run_same_input: false }), { kind: "check" }, t);
  assert.match(otherPipe.advisory.text, /save it once instead of re-running/);
  const bigOutput = decide(eff(), repeatOf({ last_duration_ms: 300, last_output_chars: 12000 }), { kind: "read" }, t);
  assert.equal(bigOutput.advisory.rule, "redundant");
  assert.doesNotMatch(bigOutput.advisory.text, /\(\d+ s\)/);
  assert.equal(decide(eff(), repeatOf({ last_duration_ms: 300, last_output_chars: 200 }), { kind: "read" }, t).advisory, null, "a cheap repeat is not worth a line");
  assert.equal(decide(eff(), repeatOf({ last_duration_ms: null, last_output_chars: null }), { kind: "read" }, t).advisory, null, "an old ledger without costs never fires");
  for (const last of ["fail", "unknown", null]) assert.notEqual(decide(eff(), repeatOf({ last_outcome_of_this_action: last }), { kind: "check" }, t).advisory?.rule, "redundant");
  for (const validity of ["stale", "unknown", "none"]) assert.notEqual(decide(eff(), repeatOf({ validity, last_pass_seq: validity === "none" ? null : 12 }), { kind: "check" }, t).advisory?.rule, "redundant", validity);
});

test("a stated reason to expect new information lifts the redundant advisory, and nothing else", () => {
  const withReason = decide(eff({ expects_new_information: { p: 0.9 } }), repeatOf(), { kind: "check" }, t);
  assert.equal(withReason.advisory.rule, "redundant");
  assert.equal(withReason.advisory.suppressed, true);
  assert.match(withReason.advisory.why, /stated a reason/);
  assert.deepEqual(withReason.fired, ["redundant"], "still recorded, so the exception can be measured");
  assert.equal(withReason.signals.expects_new_information, 0.9);
  assert.equal(decide(eff({ expects_new_information: { p: 0.79 } }), repeatOf(), { kind: "check" }, t).advisory.suppressed, false);
  const loop = decide(eff({ expects_new_information: { p: 0.95 } }), view({ failed_runs: [53, 59] }), { kind: "check" }, t);
  assert.equal(loop.advisory.rule, "repeat-failure");
  assert.equal(loop.advisory.suppressed, false, "hope is not a change: a third identical failure is called whatever the agent said");
});

test("repeat-failure: identical failures with nothing changed since, named by seq", () => {
  const r = decide(eff(), view({ failed_runs: [53, 59], last_outcome_of_this_action: "fail", validity: "stale" }), { kind: "check" }, t);
  assert.equal(r.advisory.rule, "repeat-failure");
  assert.equal(r.advisory.text, "jev-save: #53 and #59 ran this and failed; nothing changed since. Fix the cause before running it again.");
  assert.deepEqual(r.fired, ["repeat-failure"]);
  assert.equal(decide(eff(), view({ failed_runs: [53], last_outcome_of_this_action: "fail" }), { kind: "check" }, t).advisory, null, "one retry is normal");
  assert.match(decide(eff(), view({ failed_runs: [3, 5, 7] }), { kind: "check" }, t).advisory.text, /#3, #5 and #7 ran this/);
  assert.equal(decide(eff(), view({ failed_runs: [53, 59] }), { kind: "check" }, thresholds({ JEV_SAVE_FAIL_REPEATS: "3" })).advisory, null);
});

test("necessary advisory with a fact-first detail", () => {
  const low = eff({ necessary: { p: 0.12 } });
  const repeat = decide(low, view({ same_action_count_this_turn: 2 }), { kind: "read" }, t);
  assert.equal(repeat.advisory.rule, "necessary");
  assert.match(repeat.advisory.text, /same read already ran this turn \(2×\)/);
  const exploring = decide(low, view({ kinds_this_turn: { read: 5, search: 3, check: 0, edit: 0 } }), { kind: "search" }, t);
  assert.match(exploring.advisory.text, /8 calls were reads and searches with no edit/);
  const plain = decide(low, view(), { kind: "check" }, t);
  assert.match(plain.advisory.text, /next step is already clear/);
  assert.equal(decide(eff({ necessary: { p: 0.21 } }), view(), { kind: "check" }, t).advisory, null);
});

test("priority: scope beats repeat-failure beats redundant beats necessary; only one advisory", () => {
  const all = eff({ scope_expansion: { p: 0.95 }, necessary: { p: 0.05 } });
  assert.deepEqual(decide(all, repeatOf({ failed_runs: [1, 2] }), { kind: "check" }, t).fired, ["scope"]);
  assert.deepEqual(decide(eff({ necessary: { p: 0.05 } }), repeatOf({ failed_runs: [1, 2] }), { kind: "check" }, t).fired, ["repeat-failure"]);
  assert.deepEqual(decide(eff({ necessary: { p: 0.05 } }), repeatOf(), { kind: "check" }, t).fired, ["redundant"]);
});

test("suppression: a cooldown per action, a budget over the last 20 calls, and a cooldown after the last advisory", () => {
  const low = eff({ necessary: { p: 0.1 } });
  const again = decide(low, view({ advised_for_this_action: [{ rule: "necessary", calls_since: 4 }] }), { kind: "read" }, t);
  assert.equal(again.advisory.suppressed, true);
  assert.match(again.advisory.why, /already advised/);
  assert.equal(decide(low, view({ advised_for_this_action: [{ rule: "necessary", calls_since: 5 }] }), { kind: "read" }, t).advisory.suppressed, false);
  assert.equal(decide(low, view({ advised_for_this_action: [{ rule: "redundant", calls_since: 1 }] }), { kind: "read" }, t).advisory.suppressed, false, "a different finding on the same action is new");
  assert.equal(decide(low, view({ advisories_in_window: 3 }), { kind: "read" }, t).advisory.why, "advisory budget spent");
  assert.equal(decide(low, view({ advisories_this_turn: 9, advisories_in_window: 2, calls_since_last_advisory: 2 }), { kind: "read" }, t).advisory.suppressed, false, "a long headless turn is not one budget");
  assert.equal(decide(low, view({ advisories_in_window: 1, calls_since_last_advisory: 1 }), { kind: "read" }, t).advisory.why, "cooldown after the last advisory");
  assert.equal(decide(low, view({ advisories_in_window: 1, calls_since_last_advisory: 2 }), { kind: "read" }, t).advisory.suppressed, false);
});

test("decisionMargin is the weakest signal used, on a 0–1 scale", () => {
  assert.equal(decide(eff({ necessary: { p: 0.1 } }), view(), { kind: "read" }, t).decisionMargin, 0.8);
  assert.equal(decide(eff({ scope_expansion: { p: 0.9 }, in_scope: { p: 0.4 } }), view(), { kind: "edit" }, t).decisionMargin, 0.2);
  assert.equal(decide({ ...eff(), ...sec(2.9) }, view(), { kind: "write-bash" }, t).decisionMargin, 0.93);
});

test("thresholds come from the environment, with jev-guard's security thresholds alongside", () => {
  const custom = thresholds({ JEV_SAVE_NECESSARY_P: "0.3", JEV_SAVE_DENY_SCORE: "2.0" });
  assert.equal(custom.necessaryP, 0.3);
  assert.equal(custom.denyScore, 2.0);
  assert.equal(decide(eff({ necessary: { p: 0.25 } }), view(), { kind: "read" }, custom).advisory.rule, "necessary");
});
