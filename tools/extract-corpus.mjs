#!/usr/bin/env node
// Turn Claude Code transcripts into a redacted projection: one line per user turn, each with the ordered
// tool calls that followed it, classified the same way the live hooks classify them. No prompt text, no
// file contents, no tool output leaves the transcript; commands are redacted and clipped, paths reduced to
// basenames. The projection is what tools/baserate.mjs and tools/measure.mjs read.
//
// Shape follows jev-belay's tools/extract-corpus.mjs (MIT, valentynkit); the walk keeps the whole action
// sequence instead of only the per-turn counts, because repeat detection needs order.
//
//   node tools/extract-corpus.mjs [--root ~/.claude/projects] [--days 30] [--out corpus/turns.jsonl]
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { actionOutcome, classifyAction, digestOf, pathsOf, previewOf, shortPaths } from "../src/core/evidence.js";

/** Slash-command echoes and injected context are logged as user lines; they are not the user speaking. */
const NOT_A_PROMPT = /^<(?:command-name|command-message|command-args|local-command-stdout|local-command-stderr|system-reminder|teammate-message|agent-message)/;

const args = parseArgs(process.argv.slice(2));
const root = args.root ?? join(homedir(), ".claude", "projects");
const days = args.days ? Number(args.days) : null;
const out = args.out ?? join(process.cwd(), "corpus", "turns.jsonl");

const files = listTranscripts(root).filter((f) => !days || Date.now() - statSync(f).mtimeMs < days * 86_400_000);
const lines = [];
let sessions = 0, turns = 0, actions = 0;
for (const file of files) {
  const session = sha(file).slice(0, 12);
  const project = sha(basename(dirname(file))).slice(0, 8);
  const projected = projectSession(readFileSync(file, "utf8"), { session, project });
  if (!projected.length) continue;
  sessions++;
  for (const t of projected) { turns++; actions += t.actions.length; lines.push(JSON.stringify(t)); }
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, lines.join("\n") + (lines.length ? "\n" : ""));
console.error(`jev-save extract-corpus: ${files.length} transcripts → ${sessions} sessions, ${turns} turns, ${actions} tool calls → ${out}`);

// ---------------------------------------------------------------------------

export function projectSession(text, { session, project }) {
  const uses = new Map();   // tool_use id → {name, input, at}
  const turnsOut = [];
  let current = null;
  let seq = 0;
  for (const raw of text.split("\n")) {
    if (!raw) continue;
    let r;
    try { r = JSON.parse(raw); } catch { continue; }
    if (r.isSidechain) continue;
    const at = Date.parse(r.timestamp ?? "") || 0;
    if (r.type === "assistant" && Array.isArray(r.message?.content)) {
      for (const b of r.message.content) if (b?.type === "tool_use") uses.set(b.id, { name: b.name, input: b.input ?? {}, at });
      continue;
    }
    if (r.type !== "user") continue;
    if (r.toolUseResult !== undefined) {           // a tool result
      const ref = (r.message?.content ?? []).find((b) => b?.type === "tool_result");
      const use = uses.get(ref?.tool_use_id);
      if (!use || !current) continue;
      const res = r.toolUseResult;
      const isError = Boolean(ref?.is_error) || typeof res === "string";
      const interrupted = Boolean(res?.interrupted);
      const output = typeof res === "string" ? res : `${res?.stdout ?? ""}\n${res?.stderr ?? ""}`;
      const cls = classifyAction(use.name, use.input);
      const outcome = actionOutcome(cls.kind, { failed: isError, interrupted, output });
      current.actions.push({
        seq: ++seq,
        tool: use.name,
        kind: cls.kind,
        runner: cls.runner,
        digest: digestOf(use.name, use.input),
        paths: shortPaths(pathsOf(use.name, use.input)),
        outcome,
        is_error: isError,
        interrupted,
        duration_ms: use.at && at ? Math.max(0, at - use.at) : null,
        preview: cls.kind === "check" || cls.kind === "write-bash" || cls.kind === "other" ? previewOf(use.name, use.input, 100) : undefined,
      });
      continue;
    }
    if (r.isMeta) continue;
    const prompt = textOf(r.message?.content).trim();
    if (!prompt || NOT_A_PROMPT.test(prompt)) continue;
    if (current) turnsOut.push(current);
    current = { session, project, turn: turnsOut.length + 1, prompt_digest: sha(prompt).slice(0, 12), prompt_chars: prompt.length, started_at: at, actions: [] };
  }
  if (current) turnsOut.push(current);
  return turnsOut;
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n");
}

function listTranscripts(dir) {
  const found = [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return found; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "subagents") found.push(...listTranscripts(p)); }   // subagent transcripts: later
    else if (e.name.endsWith(".jsonl")) found.push(p);
  }
  return found;
}

function sha(s) { return createHash("sha1").update(String(s)).digest("hex"); }

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) o[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
  return o;
}
