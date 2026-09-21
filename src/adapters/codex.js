// Codex CLI hook events ↔ the core. Same field names as Claude Code for what we read (session_id, cwd,
// tool_name, tool_input, tool_use_id, tool_response, prompt) plus turn_id; differences that matter
// (docs/design.md §10, checked 2026-09-21):
//   - tool names: shell commands are `Bash`, file edits are `apply_patch` (tool_input.command holds the patch);
//   - there is no PostToolUseFailure: a non-zero exit also arrives as PostToolUse, so the runner
//     output parsers decide pass/fail;
//   - `permissionDecision: "ask"` is not supported — Codex marks the hook failed and runs the tool —
//     so an ASK becomes a deny that asks the model to get the user's confirmation first.
import * as claude from "./claude.js";

export const name = "codex";

export function toAction(event) {
  return { ...claude.toAction(event), agent: "codex" };
}

/** Codex's PostToolUse fires for non-zero exits too, and the documented payload carries no exit status for shell
 *  commands. If a numeric exit code is present under any of the usual names it is the host's word; otherwise the
 *  host said nothing (`hostSuccess: null`) and a check without a runner summary stays `unknown`. */
export function exitCodeOf(response) {
  if (!response || typeof response !== "object") return null;
  for (const k of ["exit_code", "exitCode", "exit_status", "exitStatus", "status_code", "returncode", "return_code", "code"]) {
    if (typeof response[k] === "number") return response[k];
    if (response.metadata && typeof response.metadata[k] === "number") return response.metadata[k];
  }
  return null;
}

export function toResult(event) {
  const r = claude.toResult(event);
  const exit = exitCodeOf(event.tool_response);
  return { ...r, failed: exit != null && exit !== 0, hostSuccess: exit == null ? null : exit === 0, interrupted: Boolean(event.tool_response && typeof event.tool_response === "object" && event.tool_response.interrupted) };
}

export function toOutput(result) {
  const e = result?.emit;
  if (!e) return null;
  if (e.kind === "deny") return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: e.text } };
  if (e.kind === "ask") {
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `${e.text} Codex cannot pause for approval here: ask the user in your next message and run it only after they confirm.` } };
  }
  return { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: e.text } };
}

export const failClosedOutput = claude.failClosedOutput;
