// What Jev gets to see for one tool call: a projection of the tool input (never the whole input — a Write
// carries a file, an apply_patch carries a patch) and the parts of the ledger view the questions refer to
// by name. Key names under `context` are shared with jev-guard's security questions
// (user_recent_messages, recent_tool_calls), so they must not be renamed.
import { redact } from "./evidence.js";
import { clip, describe } from "./ledger.js";
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

/**
 * The state object sent to Jev. Top level mirrors jev-guard (agent, tool, input, cwd, context) so its
 * security questions read the same shape; the efficiency keys live under context too.
 * @param {Action} action
 * @param {{kind:string, runner?:string}} cls
 * @param {View} v
 */
export function buildState(action, cls, v, { home } = {}) {
  const instructions = dedupe(v.recent_instructions);
  const context = {
    user_recent_messages: instructions,
    recent_tool_calls: v.recent.map(describe),
    original_request: v.original_request ?? undefined,
    recent_instructions: instructions,
    this_turn: { calls: v.calls_this_turn, reads: v.kinds_this_turn.read, searches: v.kinds_this_turn.search, checks: v.kinds_this_turn.check, edits: v.kinds_this_turn.edit },
    proposed_action_kind: cls.runner ? `${cls.kind} (${cls.runner})` : cls.kind,
    same_action_count_this_turn: v.same_action_count_this_turn,
    last_outcome_of_this_action: v.last_outcome_of_this_action ?? "never ran",
    changed_since_last_pass: v.changed_since_last_pass,
    validity: v.validity,
  };
  for (const k of Object.keys(context)) if (context[k] === undefined || (Array.isArray(context[k]) && !context[k].length && k !== "changed_since_last_pass")) delete context[k];
  return { agent: action.agent, tool: action.tool, input: projectInput(action.tool, action.input, home), cwd: redact(String(action.cwd ?? ""), home), context };
}

const dedupe = (arr) => arr.filter((x, i) => x && arr.indexOf(x) === i);
