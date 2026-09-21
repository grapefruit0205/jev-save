// What Jev gets to see for one tool call: the session as a conversation — the user's words verbatim and the
// agent's actions one line each, in order — plus a projection of the proposed call (never a whole input: a
// Write carries a file, an apply_patch carries a patch). No summary, no classifier output: interpretation is
// the model's job. The ledger's facts (what passed, what changed since) are appended as short fields for the
// questions that name them, and decided in code.
//
// Top-level keys mirror jev-guard (agent, tool, input, cwd, context) and `context.user_recent_messages`
// keeps its name because jev-guard's security questions read it.
import { redact } from "./evidence.js";
import { clip, history } from "./ledger.js";
import "./types.js";

const HEAD = 300;
const COMMAND_MAX = 2000;
const GENERIC_MAX = 500;

/** Tool input → what Jev needs to judge it. Strings are redacted; bodies are replaced by sizes and a short head. */
export function projectInput(tool, input = {}, home) {
  const name = String(tool ?? "").toLowerCase();
  const r = (s, n) => clip(redact(String(s ?? ""), home), n);
  switch (name) {
    case "bash": case "shell":
      return { command: r(input.command, COMMAND_MAX), ...(input.description ? { description: r(input.description, 200) } : {}) };
    case "edit":
      return { file_path: r(input.file_path, 300), old_string_chars: len(input.old_string), new_string_chars: len(input.new_string), new_string_head: r(input.new_string, HEAD), ...(input.replace_all ? { replace_all: true } : {}) };
    case "multiedit":
      return { file_path: r(input.file_path, 300), edits: Array.isArray(input.edits) ? input.edits.length : 0, first_new_string_head: r(input.edits?.[0]?.new_string, HEAD) };
    case "write":
      return { file_path: r(input.file_path, 300), content_chars: len(input.content), content_head: r(input.content, HEAD) };
    case "notebookedit":
      return { notebook_path: r(input.notebook_path, 300), edit_mode: input.edit_mode, new_source_chars: len(input.new_source), new_source_head: r(input.new_source, HEAD) };
    case "apply_patch": {   // Codex: tool_input.command holds the patch text
      const patch = String(input.command ?? input.patch ?? "");
      const files = [...patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map((m) => r(m[1], 200)).slice(0, 20);
      return { files, patch_chars: patch.length, patch_head: r(patch, HEAD) };
    }
    case "read": case "notebookread":
      return { file_path: r(input.file_path ?? input.path ?? input.notebook_path, 300), ...(input.offset != null ? { offset: input.offset } : {}), ...(input.limit != null ? { limit: input.limit } : {}) };
    case "grep":
      return { pattern: r(input.pattern, 200), ...(input.path ? { path: r(input.path, 300) } : {}), ...(input.glob ? { glob: r(input.glob, 100) } : {}) };
    case "glob":
      return { pattern: r(input.pattern, 200), ...(input.path ? { path: r(input.path, 300) } : {}) };
    default: {
      const out = {};
      for (const [k, v] of Object.entries(input ?? {})) out[k] = typeof v === "string" ? r(v, 200) : typeof v === "number" || typeof v === "boolean" ? v : Array.isArray(v) ? `[${v.length} items]` : v && typeof v === "object" ? "{…}" : v;
      const s = JSON.stringify(out);
      return s.length > GENERIC_MAX ? { summary: s.slice(0, GENERIC_MAX) + "…" } : out;
    }
  }
}

const len = (s) => (typeof s === "string" ? s.length : 0);

/** One line naming the proposed call, the way agent actions appear in the history. */
export function describeCall(tool, projected) {
  const name = String(tool ?? "").toLowerCase();
  if (name === "bash" || name === "shell") return `Bash ${projected.command ?? ""}`;
  if (name === "apply_patch") return `apply_patch ${(projected.files ?? []).join(", ")}`;
  const path = projected.file_path ?? projected.notebook_path ?? projected.path ?? "";
  const head = projected.new_string_head ?? projected.content_head ?? projected.first_new_string_head ?? projected.new_source_head ?? projected.pattern ?? "";
  return `${tool} ${path}${head ? `: ${clip(head, 160)}` : ""}`.trim();
}

/**
 * The state object sent to Jev.
 * @param {Action} action
 * @param {{kind:string, runner?:string}} cls
 * @param {View} v
 * @param {{history: {lines:string[], dropped:number, first_request:string|null}}} extra
 */
export function buildState(action, cls, v, { home, history: h } = {}) {
  const input = projectInput(action.tool, action.input, home);
  const real = v.recent_instructions ?? [];
  const context = {
    history: h?.lines ?? [],
    ...(h?.dropped && h.first_request ? { session_started_with: h.first_request, history_note: `${h.dropped} earlier lines omitted; session_started_with is the user's first request` } : {}),
    proposed_call: describeCall(action.tool, input),
    proposed_call_kind: cls.runner ? `${cls.kind} (${cls.runner})` : cls.kind,
    // facts the ledger knows and the questions may cite; decided in code, shown to Jev for context only
    facts: {
      same_action_runs_since_last_user_message: v.same_action_count_since_last_prompt ?? 0,
      last_outcome_of_this_action: v.last_outcome_of_this_action ?? "never ran",
      changed_since_last_pass: v.changed_since_last_pass ?? [],
      validity_of_last_pass: v.validity,
    },
    // jev-guard's security questions read these two
    user_recent_messages: real,
    recent_tool_calls: (v.recent ?? []).slice(-6).map((e) => `${e.tool} ${clip(e.preview, 80)}${e.result ? ` -> ${e.result}` : ""}`),
  };
  return { agent: action.agent, tool: action.tool, input, cwd: redact(String(action.cwd ?? ""), home), context };
}

export { history };
