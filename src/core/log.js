// The decision log: one JSON line per judgment (and per skipped or failed judgment), for `stats`,
// `watch`, labeling and the measurement tools. Append-only; rotated once at 5 MB. Everything written
// here has already passed through evidence.redact.
import { closeSync, mkdirSync, openSync, renameSync, statSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_LOG = () => process.env.JEV_SAVE_LOG ?? join(homedir(), ".jev-save", "decisions.jsonl");
const ROTATE_AT = 5 * 1024 * 1024;

/**
 * @param {object} record  {event, session, turn, seq?, tool, kind, digest, preview, decision, advisory?, emitted, mode, signals?, answers?, latency_ms?, cached?, error?, reason?}
 */
export function logDecision(record, { path = DEFAULT_LOG(), now = Date.now() } = {}) {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try { if (statSync(path).size > ROTATE_AT) renameSync(path, path + ".1"); } catch { /* no file yet */ }
    const fd = openSync(path, "a", 0o600);
    try { writeSync(fd, JSON.stringify({ at: now, ...record }) + "\n"); } finally { closeSync(fd); }
    return true;
  } catch { return false; }
}
