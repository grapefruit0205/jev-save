// `jev-save review`: the advisories that fired, what the agent did next, and a place to say whether each one
// was right. This is the live validation loop for the efficiency judgments — there is no automatic ground
// truth for "was this call necessary", so the record is: the advisory, the agent's next call in the same
// session (did it change course?), and a human label.
//
// Labels live in ~/.jev-save/labels.jsonl, one line per decision, keyed by the decision's log line
// (session + at + digest). `stats` reads them back to report precision per rule.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { DEFAULT_LOG } from "./core/log.js";

export const DEFAULT_LABELS = () => process.env.JEV_SAVE_LABELS ?? join(homedir(), ".jev-save", "labels.jsonl");
export const LABELS = ["right", "wrong", "unsure"];

const readJsonl = (path) => { try { return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
export const keyOf = (r) => `${r.session}:${r.at}:${r.digest}`;

/**
 * Every decision that produced an advisory (fired or suppressed), joined with the same session's next
 * judged-or-skipped decision so the reader can see whether the agent changed course.
 */
export function advisories({ logPath = DEFAULT_LOG(), labelsPath = DEFAULT_LABELS(), days, now = Date.now(), unlabeledOnly = false } = {}) {
  const cutoff = days ? now - days * 86_400_000 : 0;
  const rows = readJsonl(logPath).filter((r) => r.event === "pre" && r.at >= cutoff);
  const labels = new Map(readJsonl(labelsPath).map((l) => [l.key, l]));
  const bySession = new Map();
  for (const r of rows) { if (!bySession.has(r.session)) bySession.set(r.session, []); bySession.get(r.session).push(r); }
  const out = [];
  for (const [, list] of bySession) {
    list.sort((a, b) => a.at - b.at);
    list.forEach((r, i) => {
      if (!r.advisory) return;
      const next = list[i + 1] ?? null;
      const key = keyOf(r);
      const label = labels.get(key) ?? null;
      if (unlabeledOnly && label) return;
      out.push({
        key, at: r.at, session: r.session, turn: r.turn, tool: r.tool, kind: r.kind, preview: r.preview,
        rule: r.advisory.rule, suppressed: Boolean(r.advisory.suppressed), why: r.advisory.why ?? null, emitted: r.emitted === "context",
        signals: r.signals ?? {}, view: r.view ?? {},
        next: next ? { tool: next.tool, kind: next.kind, preview: next.preview, same_action: next.digest === r.digest, seconds_later: Math.round((next.at - r.at) / 1000) } : null,
        // "changed course" is a weak automatic signal: the very next call was not the same action
        changed_course: next ? next.digest !== r.digest : null,
        label: label?.label ?? null, note: label?.note ?? null,
      });
    });
  }
  return out.sort((a, b) => b.at - a.at);
}

export function label(key, value, { note = "", labelsPath = DEFAULT_LABELS(), now = Date.now() } = {}) {
  if (!LABELS.includes(value)) throw new Error(`label must be one of ${LABELS.join(", ")}`);
  mkdirSync(dirname(labelsPath), { recursive: true, mode: 0o700 });
  appendFileSync(labelsPath, JSON.stringify({ key, label: value, note, at: now }) + "\n", { mode: 0o600 });
  return true;
}

/** Precision per rule from the labels, plus the automatic changed-course rate. For `stats`. */
export function scorecard({ logPath = DEFAULT_LOG(), labelsPath = DEFAULT_LABELS(), days, now = Date.now() } = {}) {
  const items = advisories({ logPath, labelsPath, days, now });
  const rules = {};
  for (const a of items) {
    const r = (rules[a.rule] ??= { fired: 0, emitted: 0, suppressed: 0, labeled: 0, right: 0, wrong: 0, unsure: 0, emitted_with_next: 0, changed_course: 0 });
    r.fired++;
    if (a.suppressed) r.suppressed++;
    if (a.emitted) { r.emitted++; if (a.next) { r.emitted_with_next++; if (a.changed_course) r.changed_course++; } }
    if (a.label) { r.labeled++; r[a.label]++; }
  }
  return rules;
}

const clip = (s, n) => (s && s.length > n ? s.slice(0, n) + "…" : s ?? "");

export function render(items, { limit = 20, index = true } = {}) {
  if (!items.length) return "no advisories in the decision log yet";
  const lines = [];
  items.slice(0, limit).forEach((a, i) => {
    const when = new Date(a.at).toISOString().slice(5, 16).replace("T", " ");
    const tag = a.label ? `[${a.label}]` : a.emitted ? "[sent]" : a.suppressed ? `[suppressed: ${a.why}]` : "[shadow]";
    const sig = Object.entries(a.signals).filter(([k]) => ["in_scope", "necessary", "redundant", "scope_expansion"].includes(k)).map(([k, v]) => `${k}=${v}`).join(" ");
    lines.push(`${index ? `#${i + 1} ` : ""}${when}  ${a.rule.padEnd(9)} ${tag}`);
    lines.push(`   call   ${a.tool} ${clip(a.preview, 90)}`);
    lines.push(`   signal ${sig}${a.view?.validity ? `  validity=${a.view.validity}` : ""}`);
    lines.push(`   next   ${a.next ? `${a.next.tool} ${clip(a.next.preview, 80)}${a.next.same_action ? "  (same action again)" : ""}` : "(end of log)"}`);
    if (a.note) lines.push(`   note   ${a.note}`);
    lines.push(`   key    ${a.key}`);
  });
  if (items.length > limit) lines.push(`… ${items.length - limit} more (use --limit)`);
  return lines.join("\n");
}
