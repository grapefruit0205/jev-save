// The one seam between the guard and whatever answers its questions. Deliberately thin: a provider takes
// the state and the question bundle and returns answers in jev.js's normalized shape,
//   { [id]: { p?: number, choice?: string, score?: number, probabilities?: object, confidence?: number } }
// so the same benchmark input can later be run through Jev, another model, or a recorded fixture.

/**
 * @typedef {object} DecisionProvider
 * @property {string} name
 * @property {(state: object, questions: object, opts?: {env?: object, timeoutMs?: number, signal?: AbortSignal}) => Promise<Record<string, any>>} decide
 */

/** Pick the provider from the environment: `JEV_SAVE_PROVIDER=mock` for offline runs, Jev otherwise. */
export async function selectProvider(env = process.env) {
  if (env.JEV_SAVE_PROVIDER === "mock") return (await import("./mock.js")).mockProvider();
  return (await import("./jev.js")).jevProvider();
}
