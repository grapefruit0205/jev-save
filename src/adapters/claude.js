// Claude Code hook events ↔ the core. Input fields are the documented ones only
// (docs/design.md §10, checked 2026-09-22): session_id, transcript_path, cwd, hook_event_name, tool_name,
// tool_input, tool_use_id, tool_response, duration_ms, prompt, and for PostToolUseFailure error / is_interrupt.
// A permission denial fires no PostToolUse / PostToolUseFailure (PermissionDenied exists for auto mode only), which
// is why the core reads the transcript for the outcome of calls it never heard the end of.
import "../core/types.js";

export const name = "claude";

/** @returns {Action} */
export function toAction(event) {
  return {
    agent: "claude", tool: String(event.tool_name ?? ""), input: event.tool_input ?? {}, cwd: String(event.cwd ?? process.cwd()), sessionId: String(event.session_id ?? ""),
    toolUseId: event.tool_use_id ? String(event.tool_use_id) : undefined,
    transcriptPath: typeof event.transcript_path === "string" && event.transcript_path ? event.transcript_path : undefined,
  };
}

/** What recordResult needs, from a PostToolUse or PostToolUseFailure event. */
export function toResult(event) {
  const failure = event.hook_event_name === "PostToolUseFailure";
  const r = event.tool_response;
  const output = failure
    ? String(event.error ?? "")
    : typeof r === "string" ? r
    : r && typeof r === "object" ? [r.stdout, r.stderr].filter((s) => typeof s === "string").join("\n") || collect(r) : "";
  return {
    toolUseId: event.tool_use_id ? String(event.tool_use_id) : "",
    tool: String(event.tool_name ?? ""),
    input: event.tool_input ?? {},
    failed: failure,
    interrupted: failure ? Boolean(event.is_interrupt) : Boolean(r && typeof r === "object" && r.interrupted),
    output,
    // Claude Code routes a tool that failed (a non-zero exit included) to PostToolUseFailure, so a PostToolUse
    // is the host saying the call succeeded.
    hostSuccess: !failure,
    durationMs: typeof event.duration_ms === "number" ? event.duration_ms : undefined,
  };
}

/** PreToolUse output for an assess() result. `null` means "no opinion": exit 0 with no JSON. */
export function toOutput(result) {
  const e = result?.emit;
  if (!e) return null;
  if (e.kind === "deny" || e.kind === "ask") {
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: e.kind, permissionDecisionReason: e.text } };
  }
  return { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: e.text } };
}

/** Fail-closed output when the guard itself could not run (design §6). */
export function failClosedOutput(reason) {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
}

/** Every string leaf of a structured tool result, for tools whose response is not stdout/stderr. */
function collect(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => collect(v, out));
  else if (value && typeof value === "object") Object.entries(value).forEach(([k, v]) => k !== "type" && collect(v, out));
  return out.join("\n");
}
