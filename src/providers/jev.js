// JevDecisionProvider: jev-guard's client (src/jev.js) behind the provider seam. The client already
// handles both backends, the retry loop and the abort budget; this only fixes the budget default for a
// hook that must answer well inside the host's timeout.
import { ask } from "../jev.js";

export const DEFAULT_TIMEOUT_MS = 5000;

export function jevProvider({ fetchImpl } = {}) {
  const provider = {
    name: "jev",
    last: null,   // {model, usage} of the most recent answer: the version the alias resolved to
    async decide(state, questions, { env = process.env, timeoutMs, signal } = {}) {
      const budget = timeoutMs ?? +(env.JEV_SAVE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
      const meta = {};
      const answers = await ask(state, questions, { env, fetchImpl, signal, timeoutMs: budget, meta });
      provider.last = meta;
      return answers;
    },
  };
  return provider;
}
