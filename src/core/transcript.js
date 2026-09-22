// The host's own transcript (Claude Code's `transcript_path`: one JSON line per message), read for two things
// the hooks never deliver: what the agent *said* before a call, and how calls that fired no PostToolUse ended
// (a permission denial in dontAsk mode, a call the user rejected). Only the tail is read, and only parsed —
// nothing here is sent anywhere; the guard redacts and clips what it forwards.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

// 1 MB covers a few dozen calls even when the host stores large attachments between them; a result older than
// that is simply not reconciled, and the entry turns `unknown` after ten minutes as before.
const TAIL_BYTES = 1024 * 1024;
// The host's tool_result text for a call that never ran: interactive rejections, dontAsk / auto-mode denials, and
// the auto-mode classifier refusing to decide.
const DENIED = /^(?:Permission to use \S+ has been denied|Permission for this action was denied|The user doesn't want to proceed with this tool use|The user rejected|Claude requested permissions? to use \S+, but you haven't granted it|\S+ is temporarily unavailable \(overloaded\), so auto mode cannot determine)/i;

/** Last `maxBytes` of a file as text, starting at a line boundary. Empty when unreadable. */
export function readTail(path, maxBytes = TAIL_BYTES) {
  let fd;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString("utf8");
    return start === 0 ? text : text.slice(text.indexOf("\n") + 1);
  } catch { return ""; }
  finally { if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ } }
}

/**
 * @returns {{narration: string|null, results: Map<string, {error: boolean, denied: boolean, output: string}>}}
 *   `narration`: the agent's most recent text block (its stated reason for what it does next);
 *   `results`: every tool_result in the tail by tool_use_id, with the host's error flag and the text.
 */
export function parseTail(text) {
  let narration = null;
  const results = new Map();
  for (const raw of String(text ?? "").split("\n")) {
    if (!raw || !(raw.includes('"tool_result"') || raw.includes('"assistant"'))) continue;   // cheap filter before parsing
    let line;
    try { line = JSON.parse(raw); } catch { continue; }   // a half-written last line is normal
    const content = line?.message?.content;
    if (!Array.isArray(content)) continue;
    if (line.type === "assistant") {
      for (const b of content) if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) narration = b.text.trim();
    } else if (line.type === "user") {
      for (const b of content) {
        if (b?.type !== "tool_result" || !b.tool_use_id) continue;
        const output = typeof b.content === "string" ? b.content : Array.isArray(b.content) ? b.content.map((c) => (typeof c?.text === "string" ? c.text : "")).join("\n") : "";
        results.set(String(b.tool_use_id), { error: Boolean(b.is_error), denied: DENIED.test(output), output });
      }
    }
  }
  return { narration, results };
}

export function readTranscript(path) {
  if (!path) return { narration: null, results: new Map() };
  return parseTail(readTail(path));
}
