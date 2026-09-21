import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, thresholds } from "../src/core/policy.js";
import { bundle, EFFICIENCY_QUESTIONS } from "../src/core/questions.js";

const t = thresholds({});
const baseView = {
  turn: 1, original_request: "로그인 버그만 고쳐. DB는 건드리지 마.", recent_instructions: [], recent: [],
  calls_this_turn: 3, kinds_this_turn: { read: 2, search: 1, check: 0, edit: 0 },
  same_action_count_this_turn: 0, last_outcome_of_this_action: null, last_pass_seq: null, changed_since_last_pass: [], unknown_since_last_pass: false, validity: "none",
  jev_calls: 0, advisories_this_turn: 0, advisories_for_this_action_this_turn: 0, calls_since_last_advisory: Infinity,
};
const view = (o = {}) => ({ ...baseView, ...o });
const eff = (o = {}) => ({ in_scope: { p: 0.95 }, necessary: { p: 0.9 }, redundant: { p: 0.05 }, scope_expansion: { p: 0.05 }, kind: { choice: "progress" }, ...o });
const sec = (score, approval = 0.05) => ({ risk: { score }, approval: { p: approval }, user_requested: { p: 0.05 } });

test("the bundle carries the efficiency ids and, on request, jev-guard's security ids minus from_untrusted", () => {
  assert.deepEqual(Object.keys(bundle({ security: false })), Object.keys(EFFICIENCY_QUESTIONS));
  const withSec = bundle({ security: true });
  assert.ok(withSec.risk && withSec.approval && withSec.user_requested && !withSec.from_untrusted);
  assert.ok(bundle({ security: true, untrusted: true }).from_untrusted);
  for (const q of Object.values(bundle({ security: true }))) assert.ok(["noul", "choice", "score"].includes(q.type) && q.instructions.length > 20);
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
});

test("redundant advisory only when the ledger says the last pass is still valid", () => {
  const hot = eff({ redundant: { p: 0.95 }, necessary: { p: 0.1 } });
  const valid = decide(hot, view({ validity: "valid", last_pass_seq: 12, same_action_count_this_turn: 1, last_outcome_of_this_action: "pass" }), { kind: "check" }, t);
  assert.equal(valid.advisory.rule, "redundant");
  assert.match(valid.advisory.text, /#12 ran this and passed/);
  for (const validity of ["stale", "unknown", "none"]) {
    const r = decide(hot, view({ validity, last_pass_seq: validity === "none" ? null : 12 }), { kind: "check" }, t);
    assert.notEqual(r.advisory?.rule, "redundant", validity);
  }
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

test("priority: scope beats redundant beats necessary; only one advisory", () => {
  const all = eff({ scope_expansion: { p: 0.95 }, redundant: { p: 0.95 }, necessary: { p: 0.05 } });
  const r = decide(all, view({ validity: "valid", last_pass_seq: 3 }), { kind: "check" }, t);
  assert.deepEqual(r.fired, ["scope"]);
});

test("suppression: once per action per turn, a per-turn budget, and a cooldown after the last advisory", () => {
  const low = eff({ necessary: { p: 0.1 } });
  const again = decide(low, view({ advisories_for_this_action_this_turn: 1 }), { kind: "read" }, t);
  assert.equal(again.advisory.suppressed, true);
  assert.match(again.advisory.why, /already advised/);
  assert.equal(decide(low, view({ advisories_this_turn: 3 }), { kind: "read" }, t).advisory.why, "advisory budget for this turn spent");
  assert.equal(decide(low, view({ advisories_this_turn: 1, calls_since_last_advisory: 1 }), { kind: "read" }, t).advisory.why, "cooldown after the last advisory");
  assert.equal(decide(low, view({ advisories_this_turn: 1, calls_since_last_advisory: 2 }), { kind: "read" }, t).advisory.suppressed, false);
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
