// Pure policy over Jev's answers and the ledger view. No I/O, no API: everything here runs in tests.
//
// Two kinds of verdict, kept apart on purpose (docs/design.md v0.4):
//   - what the user meant: `forbidden`, `needed`, `permitted` — Jev's reading of the user's own words. The
//     live probe put these at 13/13 on prohibition / revocation / exception / moved-on-request scenarios.
//   - what already happened: whether a check is still valid, whether the same action already ran since the
//     user last spoke — the ledger's facts, which Jev read poorly (0.34 / 0.39 in the probe) and which
//     therefore gate the corresponding advisories in code.
// Security (jev-guard's risk / approval) comes first; `permitted` lifts an ask the way user_requested did.
// Efficiency judgments never block in this version: one short, fact-first advisory at most, or silence.
import { decide as securityDecide, thresholds as securityThresholds } from "../guard.js";
import { clip } from "./ledger.js";
import "./types.js";

export function thresholds(env = process.env) {
  const n = (k, d) => (env[k] !== undefined && Number.isFinite(+env[k]) ? +env[k] : d);
  return {
    ...securityThresholds(env),
    // experimental initial values, from the 2026-09-21 live probe; re-set from labeled logs
    forbiddenP: n("JEV_SAVE_FORBIDDEN_P", 0.7),
    neededP: n("JEV_SAVE_NEEDED_P", 0.25),
    permittedP: n("JEV_SAVE_PERMITTED_P", 0.85),
    maxAdvisoriesPerTurn: n("JEV_SAVE_MAX_ADVISORIES", 3),
    cooldownCalls: n("JEV_SAVE_COOLDOWN_CALLS", 2),
  };
}

const p = (a) => (typeof a?.p === "number" ? a.p : typeof a?.noul === "number" ? a.noul : undefined);
const margin = (x) => (x == null ? 0 : Math.abs(x - 0.5) * 2);
const round = (x) => (typeof x === "number" ? Math.round(x * 100) / 100 : x);

/**
 * @param {Record<string, any>} answers   jev.js shape: {p} for noul, {choice, probabilities, confidence} for choice, {score} for score
 * @param {View} view
 * @param {{kind:string}} cls
 * @returns {DecisionResult & {advisory: null | {rule:string, text:string, suppressed:boolean, why?:string}}}
 */
export function decide(answers, view, cls, t = thresholds(), { securityMode = "on" } = {}) {
  const signals = {};
  for (const id of ["forbidden", "needed", "permitted", "approval", "from_untrusted"]) if (p(answers[id]) != null) signals[id] = round(p(answers[id]));
  if (typeof answers.risk?.score === "number") signals.risk = round(answers.risk.score);
  if (answers.kind?.choice) signals.kind = answers.kind.choice;
  const forbidden = p(answers.forbidden), needed = p(answers.needed), permitted = p(answers.permitted);
  const fired = [];

  // 1. security: jev-guard's rules, with `permitted` standing in for its user_requested
  if (answers.risk && answers.approval) {
    const s = securityDecide({ ...answers, user_requested: permitted != null ? { p: permitted } : undefined }, t);
    if (s.level === "deny") {
      const r = result("DENY", `jev-save blocked this call${s.why ? ` because ${s.why}` : ""} (risk ${signals.risk}/3, approval p=${signals.approval ?? 0}). If the user really wants it, they can run it themselves.`, signals, [s.why ? "security:untrusted" : "security:risk"], [p(answers.from_untrusted), answers.risk.score / 3]);
      if (securityMode === "on") return r;
      fired.push(`${r.fired[0]}:logged`);
    } else if (s.level === "ask") {
      if (answers.risk.score >= t.askScore) {
        const r = result("ASK", `jev-save: this call needs the user's approval (risk ${signals.risk}/3, approval p=${signals.approval ?? 0}).`, signals, ["security:ask"], [p(answers.approval), answers.risk.score / 3]);
        if (securityMode === "on") return r;
        fired.push("security:ask:logged");
      } else fired.push("security:approval-only");
    }
  }

  // 2. one advisory at most, by priority
  let advisory = null;
  const request = view.current_request ?? view.original_request;
  const clearlyPermitted = permitted != null && permitted >= t.permittedP;
  if (forbidden != null && forbidden >= t.forbiddenP && !clearlyPermitted) {
    // the user said not to. (`permitted` is asked about the same words, so a clear permission overrides.)
    fired.push("forbidden");
    advisory = { rule: "forbidden", text: `jev-save: the user said not to do this (forbidden p=${round(forbidden)}). Check their instructions before continuing, or ask them.` };
  } else if (needed != null && needed <= t.neededP && answers.kind?.choice === "stale") {
    fired.push("stale");
    advisory = { rule: "stale", text: `jev-save: this works on a request that looks finished or superseded (needed p=${round(needed)}). The current request is «${clip(request ?? "", 80)}».` };
  } else if (needed != null && needed <= t.neededP && request) {
    fired.push("scope");
    advisory = { rule: "scope", text: `jev-save: this looks outside what the user asked for «${clip(request, 80)}» (needed p=${round(needed)}). Keep to the request, or ask before widening it.` };
  } else if (view.validity === "valid" && view.last_outcome_of_this_action === "pass" && view.last_pass_seq != null && (view.same_action_count_since_last_prompt ?? 0) >= 1 && !clearlyPermitted) {
    // a fact, not an interpretation: the same action already passed since the user last spoke and nothing
    // observed changed. Unless the user asked for the rerun.
    fired.push("redundant");
    advisory = { rule: "redundant", text: `jev-save: #${view.last_pass_seq} already ran this and passed since the user's last message; nothing observed changed. Skip it unless you expect new information.` };
  }

  if (advisory) {
    const why = view.advisories_for_this_action_this_turn >= 1 ? "already advised on this action this turn"
      : view.advisories_this_turn >= t.maxAdvisoriesPerTurn ? "advisory budget for this turn spent"
      : view.calls_since_last_advisory < t.cooldownCalls ? "cooldown after the last advisory"
      : null;
    advisory.suppressed = Boolean(why);
    if (why) advisory.why = why;
  }
  const rule = fired.find((f) => !f.startsWith("security:"));
  const used = rule === "forbidden" ? [forbidden] : rule === "stale" || rule === "scope" ? [needed] : rule === "redundant" ? [1] : [forbidden, needed];
  return { ...result("ALLOW", "", signals, fired, used), advisory };
}

function result(decision, reason, signals, fired, used) {
  return { decision, reason, signals, fired, decisionMargin: round(Math.min(...used.filter((x) => x != null).map(margin), 1)), advisory: null };
}
