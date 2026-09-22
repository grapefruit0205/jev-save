// MockDecisionProvider: deterministic answers derived from the state, in the same shape jev.js returns.
// Good enough to drive the whole pipeline offline (tests, `JEV_SAVE_PROVIDER=mock`, the fake API in
// tools/fake-jev.mjs). Rules can be overridden per test with `mockProvider({ rules })`.

const DEFAULT_RULES = {
  risk(state) {
    const cmd = JSON.stringify(state.input ?? {});
    return /rm -rf|DROP TABLE|sudo|curl [^|]*\| ?sh/.test(cmd) ? 2.9 : /git push|curl -X POST|--force/.test(cmd) ? 2.0 : 0.2;
  },
  approval(state, a) { return a.risk >= 2 ? 0.85 : 0.05; },
  user_requested(state) {
    const cmd = JSON.stringify(state.input ?? {});
    return (state.context?.user_recent_messages ?? []).some((m) => m.length > 5 && cmd.includes(m)) ? 0.95 : 0.05;
  },
  from_untrusted() { return 0.05; },
  scope_expansion(state) {
    const s = JSON.stringify(state.input ?? {}) + " " + (state.context?.original_request ?? "");
    return /migration|refactor|new_abstraction|AbstractBase|Factory|framework/i.test(JSON.stringify(state.input ?? {})) && !/refactor|migration/i.test(state.context?.original_request ?? "") ? 0.95 : /DB|database/i.test(state.context?.original_request ?? "") && /db\/|schema|migration/i.test(s) ? 0.9 : 0.05;
  },
  in_scope(state, a) { return 1 - a.scope_expansion; },
  redundant(state) {
    const c = state.context ?? {};
    return c.same_action_count_this_turn >= 1 && c.last_outcome_of_this_action === "pass" && c.validity === "valid" ? 0.95 : 0.05;
  },
  necessary(state, a) {
    const c = state.context ?? {};
    if (a.redundant >= 0.9) return 0.45;   // what Jev actually answers on a plain repeat (0.49–0.65 on the headless trial): the ledger, not necessary, owns repeats
    const kind = String(c.proposed_action_kind ?? "");
    if (/^(read|search)/.test(kind) && (c.this_turn?.reads ?? 0) + (c.this_turn?.searches ?? 0) >= 8 && (c.this_turn?.edits ?? 0) === 0) return 0.15;
    return 0.9;
  },
  kind(state, a) {
    const k = String(state.context?.proposed_action_kind ?? "");
    return a.scope_expansion >= 0.85 ? "expansion" : a.redundant >= 0.85 ? "repetition" : /^check/.test(k) ? "verification" : /^(read|search)/.test(k) ? "exploration" : "progress";
  },
  // the agent said why it runs this again: a suspected bad result, a changed input, a fix, another slice of the output
  expects_new_information(state) {
    return /odd|empty|expired|refresh|changed|fixed|full output|whole output|again with/i.test(String(state.context?.agent_stated_reason ?? "")) ? 0.9 : 0.1;
  },
};

export function mockProvider({ rules = {}, latencyMs = 0, name = "mock" } = {}) {
  const r = { ...DEFAULT_RULES, ...rules };
  return {
    name,
    async decide(state, questions) {
      if (latencyMs) await new Promise((res) => setTimeout(res, latencyMs));
      const a = {};
      // evaluate in dependency order, then keep only the ids that were asked
      for (const id of ["risk", "approval", "user_requested", "from_untrusted", "scope_expansion", "in_scope", "redundant", "necessary", "kind", "expects_new_information"]) a[id] = r[id](state, a);
      for (const id of Object.keys(questions)) if (!(id in a) && typeof r[id] === "function") a[id] = r[id](state, a);   // per-test extra rules
      const out = {};
      for (const [id, q] of Object.entries(questions)) {
        if (!(id in a)) continue;
        if (q.type === "score") out[id] = { score: a[id], confidence: 0.8 };
        else if (q.type === "choice") out[id] = { choice: a[id], probabilities: { [a[id]]: 0.9 }, confidence: 0.9 };
        else out[id] = { p: a[id] };
      }
      return out;
    },
  };
}

/** A provider that always fails, for the fail-open tests. */
export function failingProvider(message = "mock outage") {
  return { name: "failing", async decide() { throw new Error(message); } };
}
