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

export function toResult(event) {
  const r = claude.toResult(event);
  return { ...r, failed: false, interrupted: Boolean(event.tool_response && typeof event.tool_response === "object" && event.tool_response.interrupted) };
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
