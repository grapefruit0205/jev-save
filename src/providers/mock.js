// MockDecisionProvider: deterministic answers derived from the state, in the same shape jev.js returns.
// Good enough to drive the whole pipeline offline (tests, `JEV_SAVE_PROVIDER=mock`, the fake API in
// tools/fake-jev.mjs). Rules can be overridden per test with `mockProvider({ rules })`.

const DEFAULT_RULES = {
  risk(state) {
    const cmd = JSON.stringify(state.input ?? {});
    return /rm -rf|DROP TABLE|sudo|curl [^|]*\| ?sh/.test(cmd) ? 2.9 : /git push|curl -X POST|--force/.test(cmd) ? 2.0 : 0.2;
  },
  approval(state, a) { return a.risk >= 2 ? 0.85 : 0.05; },
  from_untrusted() { return 0.05; },
  // A toy reading of the user's words: the last "don't touch X" line that no later line lifts.
  forbidden(state) {
    const users = (state.context?.history ?? []).filter((l) => l.startsWith("user: ")).map((l) => l.slice(6));
    const call = `${state.context?.proposed_call ?? ""} ${JSON.stringify(state.input ?? {})}`;
    let forbidden = 0.05;
    for (const u of users) {
      const ban = /(?:don'?t|do not|never)\s+(?:touch|modify|edit|change)\s+(\S+)|(\S+?)(?:\s*폴더)?(?:는|은|을|를)?\s*건드리지\s*마|(\S+?)(?:\s*폴더)?(?:는|은|을|를)?\s*수정하지\s*마/i.exec(u);
      const lift = /(?:you can|ok to|allowed to|go ahead and)\s+(?:touch|modify|edit|change)\s+(\S+)|(?:이제\s+)?(\S+?)(?:\s*폴더)?(?:는|은|을|를)?\s*(?:수정해도 돼|고쳐도 돼|건드려도 돼)/i.exec(u);
      if (ban) { const what = (ban[1] ?? ban[2] ?? ban[3] ?? "").replace(/[.,:]$/, ""); if (what && call.toLowerCase().includes(what.toLowerCase())) forbidden = 0.95; }
      if (lift) { const what = (lift[1] ?? lift[2] ?? "").replace(/[.,:]$/, ""); if (what && call.toLowerCase().includes(what.toLowerCase())) forbidden = 0.05; }
    }
    return forbidden;
  },
  needed(state, a) {
    if (a.forbidden >= 0.7) return 0.05;
    const users = (state.context?.history ?? []).filter((l) => l.startsWith("user: "));
    const last = users.at(-1) ?? "";
    const call = state.context?.proposed_call ?? "";
    if (/migration|refactor|AbstractBase|Factory/i.test(call) && !/migration|refactor/i.test(last)) return 0.08;
    return 0.85;
  },
  permitted(state) {
    const users = (state.context?.history ?? []).filter((l) => l.startsWith("user: ")).map((l) => l.slice(6));
    const cmd = String(state.input?.command ?? state.context?.proposed_call ?? "");
    return users.some((u) => u.length > 5 && cmd.includes(u)) ? 0.95 : 0.05;
  },
  kind(state, a) {
    const k = String(state.context?.proposed_call_kind ?? "");
    return a.forbidden >= 0.7 ? "violation" : a.needed <= 0.25 ? "expansion" : /^check/.test(k) ? "auxiliary" : /^(read|search)/.test(k) ? "auxiliary" : "progress";
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
      for (const id of ["risk", "approval", "from_untrusted", "forbidden", "needed", "permitted", "kind"]) a[id] = r[id](state, a);
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
