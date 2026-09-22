// Pure policy over Jev's answers and the ledger view. No I/O, no API: everything here runs in tests.
//
// Order: jev-guard's security decision first (deny / ask), then at most one efficiency advisory —
// scope, then repeat-failure, then redundant, then necessary — subject to the suppression rules below.
// The two repeat rules read the ledger only: whether a call repeats one that ran, how that run ended, what it
// cost and what changed since are facts the ledger records, and Jev never confirmed them (bundle v2 note in
// questions.js). Jev's part in a repeat is the exception: a stated reason to expect something new.
// Efficiency judgments never block; they produce a short, fact-first message that the guard emits as
// additionalContext in advise mode and only logs in shadow mode.
import { decide as securityDecide, thresholds as securityThresholds } from "../guard.js";
import { clip } from "./ledger.js";
import "./types.js";

export function thresholds(env = process.env) {
  const n = (k, d) => (env[k] !== undefined && Number.isFinite(+env[k]) ? +env[k] : d);
  return {
    ...securityThresholds(env),
    // experimental initial values: to be re-set from shadow logs (design v0.2 §7)
    necessaryP: n("JEV_SAVE_NECESSARY_P", 0.2),
    expansionP: n("JEV_SAVE_EXPANSION_P", 0.85),
    inScopeP: n("JEV_SAVE_INSCOPE_P", 0.15),
    // off-request *and* needing approval: a forbidden action rather than an added one (a commit against "no
    // commits" scored in_scope 0.04 / approval 0.96 / expansion 0.44). 0 of 354 interactive decisions reach it.
    approvalScopeP: n("JEV_SAVE_APPROVAL_SCOPE_P", 0.9),
    // a repeat is worth a line only when re-running costs something: wall time or context
    repeatMinMs: n("JEV_SAVE_REPEAT_MIN_MS", 5000),
    repeatMinChars: n("JEV_SAVE_REPEAT_MIN_CHARS", 4000),
    // the agent's stated reason lifts a redundant advisory at or above this
    reasonP: n("JEV_SAVE_REASON_P", 0.8),
    // identical failures before the next attempt is called a loop
    failRepeats: n("JEV_SAVE_FAIL_REPEATS", 2),
    maxAdvisoriesPerWindow: n("JEV_SAVE_MAX_ADVISORIES", 3),
    cooldownCalls: n("JEV_SAVE_COOLDOWN_CALLS", 2),
    actionCooldownCalls: n("JEV_SAVE_ACTION_COOLDOWN_CALLS", 5),
  };
}

const p = (a) => (typeof a?.p === "number" ? a.p : typeof a?.noul === "number" ? a.noul : undefined);
const margin = (x) => (x == null ? 0 : Math.abs(x - 0.5) * 2);

/**
 * @param {Record<string, any>} answers   jev.js shape: {p} for noul, {choice, probabilities, confidence} for choice, {score} for score
 * @param {View} view
 * @param {{kind:string}} cls
 * @param {ReturnType<typeof thresholds>} t
 * @returns {DecisionResult & {advisory: null | {rule:string, text:string, suppressed:boolean, why?:string}}}
 */
export function decide(answers, view, cls, t = thresholds(), { securityMode = "on" } = {}) {
  const signals = {};
  for (const id of ["in_scope", "necessary", "redundant", "scope_expansion", "expects_new_information", "approval", "user_requested", "from_untrusted"]) if (p(answers[id]) != null) signals[id] = round(p(answers[id]));
  if (typeof answers.risk?.score === "number") signals.risk = round(answers.risk.score);
  if (answers.kind?.choice) signals.kind = answers.kind.choice;

  // 1. security (jev-guard's rules); only meaningful when the security questions were asked. In `log` mode the
  //    verdict is recorded in `fired` and the advisories still get their turn: the host's own permission layer
  //    keeps the gate, jev-save only observes.
  const fired = [];
  if (answers.risk && answers.approval) {
    const s = securityDecide(answers, t);
    if (s.level === "deny") {
      const r = result("DENY", `jev-save blocked this call${s.why ? ` because ${s.why}` : ""} (risk ${signals.risk}/3, approval p=${signals.approval ?? 0}). If the user really wants it, they can run it themselves.`, signals, [s.why ? "security:untrusted" : "security:risk"], [p(answers.from_untrusted), answers.risk.score / 3]);
      if (securityMode === "on") return r;
      fired.push(`${r.fired[0]}:logged`);
    } else if (s.level === "ask") {
      // With the efficiency context in view, `approval` reacts to the request itself (an off-request edit scores
      // 0.8–0.95 at risk 1.0). That is the scope advisory's job, so approval alone asks only when the risk score
      // also says the call is hard to undo (≥ askScore); otherwise it is recorded and the advisories decide.
      if (answers.risk.score >= t.askScore) {
        const r = result("ASK", `jev-save: this call needs the user's approval (risk ${signals.risk}/3, approval p=${signals.approval ?? 0}).`, signals, ["security:ask"], [p(answers.approval), answers.risk.score / 3]);
        if (securityMode === "on") return r;
        fired.push("security:ask:logged");
      } else fired.push("security:approval-only");
    }
  }

  // 2. one efficiency advisory at most, by priority
  let advisory = null;
  const inScope = p(answers.in_scope), expansion = p(answers.scope_expansion), necessary = p(answers.necessary), approval = p(answers.approval), reason = p(answers.expects_new_information);
  // scope needs a request to be measured against, and the two signals must agree: a low in_scope with a low
  // scope_expansion means "not needed", which is necessary's case, not scope's (first live false positive:
  // in_scope 0.15 / expansion 0.18 against a pasted terminal output that had been taken for the request)
  const offRequest = inScope != null && inScope <= t.inScopeP;
  const scopeHit = view.original_request && ((expansion != null && (expansion >= t.expansionP || (offRequest && expansion >= 0.5))) || (offRequest && approval != null && approval >= t.approvalScopeP));
  const costly = (view.last_duration_ms ?? 0) >= t.repeatMinMs || (view.last_output_chars ?? 0) >= t.repeatMinChars;
  if (scopeHit) {
    fired.push("scope");
    const prob = expansion != null && expansion >= t.expansionP ? expansion : 1 - inScope;
    advisory = { rule: "scope", text: `jev-save: this looks outside the request «${clip(view.original_request ?? "", 80)}» (scope p=${round(prob)}). Keep to the request, or ask the user before widening it.` };
  } else if ((view.failed_runs ?? []).length >= t.failRepeats) {
    fired.push("repeat-failure");
    advisory = { rule: "repeat-failure", text: `jev-save: ${seqs(view.failed_runs)} ran this and failed; nothing changed since. Fix the cause before running it again.` };
  } else if (view.validity === "valid" && view.last_outcome_of_this_action === "pass" && view.last_pass_seq != null && costly) {
    fired.push("redundant");
    const cost = view.last_duration_ms >= t.repeatMinMs ? ` (${Math.round(view.last_duration_ms / 1000)} s)` : "";
    const hint = view.last_run_same_input === false ? "If you need another part of its output, save it once instead of re-running." : "Skip it unless you expect new information.";
    advisory = { rule: "redundant", text: `jev-save: #${view.last_pass_seq} ran this${cost} and passed; nothing changed since. ${hint}` };
    if (reason != null && reason >= t.reasonP) advisory.why = "the agent stated a reason to expect new information";
  } else if (necessary != null && necessary <= t.necessaryP) {
    fired.push("necessary");
    advisory = { rule: "necessary", text: `jev-save: this call looks unlikely to move the request forward (necessary p=${round(necessary)}). ${necessaryDetail(view, cls)}` };
  }

  if (advisory) {
    // the same rule on the same action is said once per cooldown; a different finding on it (a loop after a repeat) is new
    const sameRule = (view.advised_for_this_action ?? []).filter((a) => a.rule === advisory.rule).at(-1);
    const why = advisory.why
      ?? (sameRule && sameRule.calls_since < t.actionCooldownCalls ? "already advised on this action recently"
      : view.advisories_in_window >= t.maxAdvisoriesPerWindow ? "advisory budget spent"
      : view.calls_since_last_advisory < t.cooldownCalls ? "cooldown after the last advisory"
      : null);
    advisory.suppressed = Boolean(why);
    if (why) advisory.why = why;
  }
  const rule = fired.find((f) => !f.startsWith("security:"));
  const used = rule === "scope" ? [expansion, inScope] : rule === "necessary" ? [necessary] : rule ? [] : [necessary, inScope];   // the repeat rules are the ledger's facts: margin 1
  return { ...result("ALLOW", "", signals, fired, used), advisory };
}

function necessaryDetail(view, cls) {
  const k = view.kinds_this_turn;
  if (view.same_action_count_this_turn >= 1) return `The same ${cls.kind} already ran this turn (${view.same_action_count_this_turn}×).`;
  if (k.read + k.search >= 6 && k.edit === 0) return `The last ${k.read + k.search} calls were reads and searches with no edit; if you already know what to change, make the change.`;
  return "If the next step is already clear, take it.";
}

const seqs = (list) => (list.length <= 1 ? list.map((s) => `#${s}`).join("") : `${list.slice(0, -1).map((s) => `#${s}`).join(", ")} and #${list[list.length - 1]}`);

function result(decision, reason, signals, fired, used) {
  return { decision, reason, signals, fired, decisionMargin: round(Math.min(...used.filter((x) => x != null).map(margin), 1)), advisory: null };
}

const round = (x) => (typeof x === "number" ? Math.round(x * 100) / 100 : x);
