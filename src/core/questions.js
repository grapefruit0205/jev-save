// The questions Jev is asked about one tool call, all in one request. Ids are stable; wording is tuned
// against shadow logs (bump BUNDLE_VERSION when it changes, so cached answers and measurements stay
// comparable). The security questions are jev-guard's, unchanged.
import { ACTION_QUESTIONS } from "../guard.js";

// v2 (2026-09-22): `redundant` dropped — with the ledger's own facts in view (same producer, last run passed,
// nothing changed) Jev still answered 0.07–0.18 on the headless trial's plan re-runs, so the repeat rules read
// the ledger directly; `expects_new_information` added, asked only when the call repeats one that ran.
export const BUNDLE_VERSION = 2;

export const EFFICIENCY_QUESTIONS = {
  in_scope: {
    type: "noul",
    instructions:
      "The user's request is context.original_request; later instructions are context.recent_instructions. " +
      "Is this tool call work that completing the request needs — including auxiliary work a careful engineer does to complete it, " +
      "such as reading related code, adding or adjusting tests for the change, or a temporary debug print — rather than work that widens what will be delivered?",
    criteria: {
      true: "The call serves the request as asked, directly or as auxiliary work needed to complete it.",
      false: "The call delivers something beyond the request: a new feature, an unrelated refactor, a new abstraction or module nobody asked for, a migration, or a change in an area the user said to leave alone.",
    },
  },
  necessary: {
    type: "noul",
    instructions:
      "Given what the agent has already done and learned (context.recent_tool_calls with their outcomes, and the counts in context.this_turn), " +
      "is this call likely to move the request forward now? A call that repeats a read or search whose result is already known, " +
      "or that keeps exploring when the next step is already clear from what was read, is not necessary.",
    criteria: {
      true: "Yes: the call produces information or a change the request still needs.",
      false: "No: the agent already has what this call would give, or the call does not advance the request.",
    },
  },
  scope_expansion: {
    type: "noul",
    instructions:
      "Does this call introduce something the request did not ask for: a new abstraction or module, a refactor of code unrelated to the change, a schema or data migration, " +
      "an additional feature, a new dependency, a configuration change, or an edit in an area the user said to leave alone? " +
      "Adding a test for the change, reading neighbouring code, or a small helper inside the touched file does not count.",
    criteria: {
      true: "Yes: the call widens the delivered change beyond the request.",
      false: "No: the call stays within the request or is auxiliary to it.",
    },
  },
  kind: {
    type: "choice",
    instructions: "What best describes this tool call in the context of the request?",
    criteria: {
      progress: "A change or command that directly advances the request.",
      verification: "Runs tests, a build or a linter to check work already done.",
      exploration: "Reads or searches to understand the code before acting.",
      repetition: "Repeats an earlier action with no new information expected.",
      expansion: "Adds scope the request did not ask for.",
    },
  },
};

/**
 * Asked only when the call repeats one that already ran and the agent said something first. The ledger knows the
 * repeat is a repeat; what it cannot know is whether the agent has a reason — "the grep came back empty, let me
 * see the whole output", "credentials were refreshed" — and a stated reason is what turns a redundant re-run into
 * a deliberate one (trial 2026-09-22: 0.90 / 0.90 / 0.85 on the three re-runs with a reason, 0.19 / 0.23 without).
 */
export const REASON_QUESTION = {
  expects_new_information: {
    type: "noul",
    instructions:
      "context.agent_stated_reason is the agent's own most recent narration before this call. context.same_action_count_this_turn and context.last_outcome_of_this_action say this call repeats an earlier one. " +
      "Does the narration give a concrete reason to expect a different result this time — a suspected wrong or incomplete earlier result, an input or credential that changed, a fix applied since, or a different slice of a large output the agent has not seen?",
    criteria: {
      true: "Yes: a concrete, stated reason to run it again.",
      false: "No: no reason is stated, or the stated plan does not involve this call producing new information.",
    },
  },
};

/**
 * Asked once per user prompt, at UserPromptSubmit, so the ledger knows which text the request *is*. In a
 * conversation the request is not the first prompt for ever: a task replaces it, "부탁할게" after a proposal makes
 * the proposal the request, a pasted document is material to work from, a question or a remark changes nothing.
 * Every wrong scope advisory in the interactive log came from measuring against the wrong text; on the three
 * sessions that produced them (129 prompts) this classification took the 9 wrong ones to 0 with 0 of 26 in-scope
 * controls turned wrong (docs/trial-2026-09-22.md).
 */
export const PROMPT_QUESTIONS = {
  message_kind: {
    type: "choice",
    instructions: "state.user_message is one message the user sent to a coding agent mid-session; state.previous_assistant_message is what the agent had just said. What is the user's message?",
    criteria: {
      task: "A request for work: what to do, fix, build, check, explain, or change — including a new task that replaces the previous one.",
      approval: "A go-ahead for what the assistant just proposed or asked about (yes, do it, go ahead, option 2, 부탁할게, ㄱㄱ), adding little or nothing of its own.",
      paste: "Material rather than an instruction: a pasted document, log, command output, table, error text, or data, possibly with a short remark attached.",
      question: "A question or a request for an explanation that does not ask the agent to change anything.",
      steer: "A correction, constraint or redirection on work already under way (don't touch X, use Y instead, stop, revert, not that one).",
    },
  },
  refers_to_previous: {
    type: "noul",
    instructions: "Can state.user_message be understood only together with state.previous_assistant_message — it points at something the assistant said (that, it, this one, the second option, the file you mentioned) or answers a question the assistant asked?",
    criteria: { true: "Yes: on its own the message is incomplete or ambiguous.", false: "No: the message stands on its own." },
  },
};

export const SECURITY_QUESTIONS = ACTION_QUESTIONS;

/**
 * One bundle per call. `security` adds jev-guard's four questions; `untrusted` keeps `from_untrusted`
 * only when the session actually tracks flagged content (it does not in the MVP, so the question
 * would be asked against an empty list and is dropped); `reason` adds the stated-reason question.
 */
export function bundle({ security = true, untrusted = false, reason = false } = {}) {
  const q = { ...EFFICIENCY_QUESTIONS };
  if (reason) Object.assign(q, REASON_QUESTION);
  if (security) {
    for (const [id, question] of Object.entries(SECURITY_QUESTIONS)) if (id !== "from_untrusted" || untrusted) q[id] = question;
  }
  return q;
}
