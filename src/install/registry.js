// What `jev-save install` wrote, verbatim, so `uninstall` removes exactly that and nothing else.
// A hook entry is "ours" only if it deep-equals one recorded here for that file and event — never
// because a string happens to contain "jev-save" (another tool could mention us in its own hook).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const REGISTRY = () => process.env.JEV_SAVE_REGISTRY ?? join(homedir(), ".jev-save", "installed.json");

export function readRegistry(path = REGISTRY()) {
  try { const r = JSON.parse(readFileSync(path, "utf8")); return r && typeof r === "object" && r.files ? r : { version: 1, files: {} }; } catch { return { version: 1, files: {} }; }
}

export function writeRegistry(registry, path = REGISTRY()) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(registry, null, 2) + "\n", { mode: 0o600 });
}

/** Remember the entries written into `file`, keyed by event name. Replaces any earlier record for that file. */
export function remember(file, entries, { path = REGISTRY(), backup, at = new Date().toISOString() } = {}) {
  const r = readRegistry(path);
  r.files[file] = { at, backup, entries };
  writeRegistry(r, path);
}

export function forget(file, path = REGISTRY()) {
  const r = readRegistry(path);
  delete r.files[file];
  writeRegistry(r, path);
}

export const sameEntry = (a, b) => JSON.stringify(a) === JSON.stringify(b);
