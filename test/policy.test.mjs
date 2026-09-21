import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, thresholds } from "../src/core/policy.js";
import { bundle, INTENT_QUESTIONS } from "../src/core/questions.js";

const t = thresholds({});
const baseView = {
  turn: 1, original_request: "로그인 버그만 고쳐. DB는 건드리지 마.", current_request: "로그인 버그만 고쳐. DB는 건드리지 마.", recent_instructions: [], recent: [],
  calls_this_turn: 3, kinds_this_turn: { read: 2, search: 1, check: 0, edit: 0 },
  same_action_count_this_turn: 0, same_action_count_since_last_prompt: 0, last_outcome_of_this_action: null, last_pass_seq: null, changed_since_last_pass: [], unknown_since_last_pass: false, validity: "none",
  jev_calls: 0, advisories_this_turn: 0, advisories_for_this_action_this_turn: 0, calls_since_last_advisory: Infinity,
};
const view = (o = {}) => ({ ...baseView, ...o });
const intent = (o = {}) => ({ forbidden: { p: 0.05 }, needed: { p: 0.85 }, permitted: { p: 0.1 }, kind: { choice: "progress" }, ...o });
const sec = (score, approval = 0.05) => ({ risk: { score }, approval: { p: approval } });

test("the bundle carries the intent ids and, on request, jev-guard's risk/approval (its user_requested is replaced by permitted)", () => {
  assert.deepEqual(Object.keys(bundle({ security: false })), ["forbidden", "needed", "permitted", "kind"]);
  const withSec = bundle({ security: true });
  assert.ok(withSec.risk && withSec.approval && !withSec.user_requested && !withSec.from_untrusted);
  assert.ok(bundle({ security: true, untrusted: true }).from_untrusted);
  for (const q of Object.values(INTENT_QUESTIONS)) assert.ok(["noul", "choice"].includes(q.type) && /history|user's words/.test(q.instructions));
});

test("a clean call is ALLOW with no advisory", () => {
  const r = decide(intent(), view(), { kind: "edit" }, t);
  assert.equal(r.decision, "ALLOW");
  assert.equal(r.advisory, null);
  assert.deepEqual(r.fired, []);
  assert.equal(r.signals.needed, 0.85);
  assert.equal(r.signals.kind, "progress");
});

test("security first: high risk denies, mid risk asks, and the user's clear permission lifts an ask (never a deny)", () => {
  assert.equal(decide({ ...intent(), ...sec(2.9) }, view(), { kind: "write-bash" }, t).decision, "DENY");
  const ask = decide({ ...intent(), ...sec(2.0, 0.8) }, view(), { kind: "write-bash" }, t);
  assert.equal(ask.decision, "ASK");
  assert.equal(decide({ ...intent({ permitted: { p: 0.95 } }), ...sec(2.0, 0.8) }, view(), { kind: "write-bash" }, t).decision, "ALLOW", "permitted stands in for user_requested");
  assert.equal(decide({ ...intent({ permitted: { p: 0.99 } }), ...sec(2.9) }, view(), { kind: "write-bash" }, t).decision, "DENY");
  const untrusted = decide({ ...intent(), ...sec(0.2), from_untrusted: { p: 0.9 } }, view(), { kind: "write-bash" }, t);
  assert.equal(untrusted.decision, "DENY");
  // approval alone at a low risk score is not an ask
  assert.equal(decide({ ...intent(), ...sec(1.0, 0.9) }, view(), { kind: "edit" }, t).decision, "ALLOW");
  // log mode records the verdict and still evaluates the advisories
  const logged = decide({ ...intent({ forbidden: { p: 0.95 } }), ...sec(2.9) }, view(), { kind: "write-bash" }, t, { securityMode: "log" });
  assert.equal(logged.decision, "ALLOW");
  assert.deepEqual(logged.fired, ["security:risk:logged", "forbidden"]);
});

test("forbidden: the user said not to; a clear later permission overrides", () => {
  const r = decide(intent({ forbidden: { p: 0.94 }, needed: { p: 0.04 }, kind: { choice: "violation" } }), view(), { kind: "edit" }, t);
  assert.equal(r.decision, "ALLOW", "advisories never block");
  assert.equal(r.advisory.rule, "forbidden");
  assert.match(r.advisory.text, /the user said not to do this \(forbidden p=0\.94\)/);
  assert.equal(decide(intent({ forbidden: { p: 0.69 } }), view(), { kind: "edit" }, t).advisory, null);
  const lifted = decide(intent({ forbidden: { p: 0.8 }, permitted: { p: 0.9 } }), view(), { kind: "edit" }, t);
  assert.equal(lifted.advisory, null, "a clear permission in the same words wins");
});

test("stale and scope: low needed, split by Jev's kind, quoting the current request", () => {
  const stale = decide(intent({ needed: { p: 0.03 }, kind: { choice: "stale" } }), view({ current_request: "이제 ALB 액세스 로그만 켜 줘." }), { kind: "write-bash" }, t);
  assert.equal(stale.advisory.rule, "stale");
  assert.match(stale.advisory.text, /finished or superseded/);
  assert.match(stale.advisory.text, /«이제 ALB 액세스 로그만 켜 줘\.»/);
  const scope = decide(intent({ needed: { p: 0.08 }, kind: { choice: "expansion" } }), view(), { kind: "edit" }, t);
  assert.equal(scope.advisory.rule, "scope");
  assert.match(scope.advisory.text, /outside what the user asked for «로그인 버그만 고쳐/);
  const disagree = decide(intent({ needed: { p: 0.09 }, kind: { choice: "auxiliary" } }), view(), { kind: "read" }, t);
  assert.equal(disagree.advisory, null, "low needed with kind=auxiliary is not scope (every v0.4 false positive)");
  assert.deepEqual(disagree.fired, ["needed-low:no-advisory"]);
  assert.equal(decide(intent({ needed: { p: 0.09 }, kind: { choice: "progress" } }), view(), { kind: "edit" }, t).advisory, null);
  assert.equal(decide(intent({ needed: { p: 0.26 }, kind: { choice: "expansion" } }), view(), { kind: "edit" }, t).advisory, null);
  assert.equal(decide(intent({ needed: { p: 0.08 }, kind: { choice: "expansion" } }), view({ current_request: null, original_request: null }), { kind: "edit" }, t).advisory, null, "no request, no scope judgment");
});

test("redundant is a ledger fact, not a Jev reading: same action already passed since the user last spoke, nothing changed", () => {
  const facts = { validity: "valid", last_outcome_of_this_action: "pass", last_pass_seq: 12, same_action_count_since_last_prompt: 1 };
  const r = decide(intent(), view(facts), { kind: "check" }, t);
  assert.equal(r.advisory.rule, "redundant");
  assert.match(r.advisory.text, /#12 already ran this and passed since the user's last message/);
  for (const v of [{ validity: "stale" }, { validity: "unknown" }, { last_outcome_of_this_action: "fail" }, { same_action_count_since_last_prompt: 0 }]) {
    assert.equal(decide(intent(), view({ ...facts, ...v }), { kind: "check" }, t).advisory, null, JSON.stringify(v));
  }
  assert.equal(decide(intent({ permitted: { p: 0.93 } }), view(facts), { kind: "check" }, t).advisory, null, "the user asked for the rerun");
});

test("priority: forbidden beats stale beats scope beats redundant; only one advisory", () => {
  const all = intent({ forbidden: { p: 0.95 }, needed: { p: 0.02 }, kind: { choice: "stale" } });
  const facts = { validity: "valid", last_outcome_of_this_action: "pass", last_pass_seq: 3, same_action_count_since_last_prompt: 1 };
  assert.deepEqual(decide(all, view(facts), { kind: "check" }, t).fired, ["forbidden"]);
  assert.deepEqual(decide(intent({ needed: { p: 0.02 }, kind: { choice: "stale" } }), view(facts), { kind: "check" }, t).fired, ["stale"]);
});

test("suppression: once per action per turn, a per-turn budget, and a cooldown after the last advisory", () => {
  const hot = intent({ forbidden: { p: 0.9 } });
  const again = decide(hot, view({ advisories_for_this_action_this_turn: 1 }), { kind: "edit" }, t);
  assert.equal(again.advisory.suppressed, true);
  assert.match(again.advisory.why, /already advised/);
  assert.equal(decide(hot, view({ advisories_this_turn: 3 }), { kind: "edit" }, t).advisory.why, "advisory budget for this turn spent");
  assert.equal(decide(hot, view({ advisories_this_turn: 1, calls_since_last_advisory: 1 }), { kind: "edit" }, t).advisory.why, "cooldown after the last advisory");
  assert.equal(decide(hot, view({ advisories_this_turn: 1, calls_since_last_advisory: 2 }), { kind: "edit" }, t).advisory.suppressed, false);
});

test("decisionMargin is the weakest signal used, on a 0–1 scale", () => {
  assert.equal(decide(intent({ forbidden: { p: 0.9 } }), view(), { kind: "edit" }, t).decisionMargin, 0.8);
  assert.equal(decide(intent({ needed: { p: 0.1 }, kind: { choice: "expansion" } }), view(), { kind: "edit" }, t).decisionMargin, 0.8);
  assert.equal(decide({ ...intent(), ...sec(2.9) }, view(), { kind: "write-bash" }, t).decisionMargin, 0.93);
});

test("thresholds come from the environment, with jev-guard's security thresholds alongside", () => {
  const custom = thresholds({ JEV_SAVE_FORBIDDEN_P: "0.5", JEV_SAVE_DENY_SCORE: "2.0" });
  assert.equal(custom.forbiddenP, 0.5);
  assert.equal(custom.denyScore, 2.0);
  assert.equal(decide(intent({ forbidden: { p: 0.55 } }), view(), { kind: "edit" }, custom).advisory.rule, "forbidden");
});
