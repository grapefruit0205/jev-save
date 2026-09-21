// Shared shapes, as JSDoc so the code stays plain ESM with no build step.
// Nothing here executes; import it for editor help only (`import "./types.js"`).

/**
 * One tool call as every host adapter presents it to the core. `agent` names the host; `input` is the
 * host's raw tool input (the core never forwards it whole to Jev — context.js projects it).
 * @typedef {object} Action
 * @property {'claude'|'codex'} agent
 * @property {string} tool            host tool name as reported (Bash, Edit, apply_patch, mcp__x__y …)
 * @property {object} input
 * @property {string} cwd
 * @property {string} sessionId
 * @property {string} [toolUseId]     the host's execution key; digest is only for "same action?"
 */

/**
 * Events are what the ledger stores: one JSON line each, append-only, never rewritten in place.
 * `pre` is written by PreToolUse, `post` by PostToolUse / PostToolUseFailure, `prompt` by UserPromptSubmit.
 * @typedef {object} LedgerEvent
 * @property {1} v
 * @property {'prompt'|'pre'|'post'} ev
 * @property {number} at              Date.now()
 * @property {number} [turn]          prompt: the new turn number; pre: the turn it belongs to
 * @property {string} [text]          prompt: redacted, clipped
 * @property {string} [digest]        prompt: sha of the full text; pre: action identity (evidence.digestOf)
 * @property {string} [tool_use_id]
 * @property {string} [tool]
 * @property {ActionKind} [kind]
 * @property {'test'|'build'|'lint'} [runner]
 * @property {string} [preview]       redacted, ≤120 chars
 * @property {string[]} [paths]
 * @property {string} [cwd]
 * @property {Decision} [decision]    pre: what policy said (SKIP when Jev was not asked)
 * @property {Mode} [mode]
 * @property {boolean} [judged]       pre: true when a Jev call was made for it
 * @property {boolean} [advised]      pre: true when an advisory was emitted to the agent
 * @property {ExecState} [exec]       pre: running | blocked;  post: completed | failed
 * @property {Result} [result]        post
 * @property {number} [duration_ms]   post
 */

/** @typedef {'check'|'read'|'search'|'edit'|'write-bash'|'vcs'|'external'|'external-write'|'other'} ActionKind */
/** @typedef {'ALLOW'|'RETRY'|'ASK'|'DENY'|'SKIP'} Decision */
/** @typedef {'shadow'|'advise'} Mode */
/** @typedef {'proposed'|'blocked'|'running'|'completed'|'failed'|'unknown'} ExecState */
/** @typedef {'pass'|'fail'|'unknown'} Result */

/**
 * A `pre` event joined with its `post` (if any) after replay.
 * @typedef {object} LedgerEntry
 * @property {number} seq
 * @property {number} turn
 * @property {string} tool_use_id
 * @property {string} tool
 * @property {ActionKind} kind
 * @property {'test'|'build'|'lint'} [runner]
 * @property {string} digest
 * @property {string} preview
 * @property {string[]} paths
 * @property {string} cwd
 * @property {Decision} decision
 * @property {boolean} judged
 * @property {boolean} advised
 * @property {ExecState} exec
 * @property {Result|null} result
 * @property {number} started_at
 * @property {number|null} ended_at
 * @property {number|null} duration_ms
 */

/**
 * What the guard (and, projected, Jev) gets to know about the session at the moment of one action.
 * @typedef {object} View
 * @property {number} turn
 * @property {string|null} original_request     first real prompt of the session, clipped
 * @property {string[]} recent_instructions     last 3 prompts, clipped
 * @property {LedgerEntry[]} recent             last 10 entries, oldest first
 * @property {number} calls_this_turn
 * @property {{read:number, search:number, check:number, edit:number}} kinds_this_turn
 * @property {number} same_action_count_this_turn   entries in this turn with the same digest (any exec state)
 * @property {Result|null} last_outcome_of_this_action
 * @property {number|null} last_pass_seq
 * @property {string[]} changed_since_last_pass      previews of change-kind entries after last_pass_seq
 * @property {boolean} unknown_since_last_pass
 * @property {'valid'|'stale'|'unknown'|'none'} validity
 * @property {number} jev_calls                      how many entries in this session were judged
 * @property {number} advisories_this_turn
 * @property {number} advisories_for_this_action_this_turn
 * @property {number} calls_since_last_advisory       Infinity when none this turn
 */

/**
 * @typedef {object} DecisionResult
 * @property {Decision} decision
 * @property {number} decisionMargin   min over the signals used of |p − 0.5| × 2; a margin, not calibrated accuracy
 * @property {string} reason           what the agent is told (empty for ALLOW)
 * @property {Record<string, number>} signals
 * @property {string[]} fired          which rules produced the decision, e.g. ["necessary"], ["security:risk"]
 */

export {};
