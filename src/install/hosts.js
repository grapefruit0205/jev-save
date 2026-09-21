// `jev-save install claude|codex` and `uninstall`: register the hook in the host's user config without
// touching anyone else's entries. Every install backs the file up first (`<file>.jev-save.bak-<stamp>`)
// and records exactly what it added in ~/.jev-save/installed.json; uninstall removes only entries that
// deep-equal a recorded one and leaves the backups in place.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { forget, readRegistry, remember, sameEntry } from "./registry.js";

const CLAUDE_EVENTS = ["PreToolUse", "PostToolUse", "PostToolUseFailure", "UserPromptSubmit"];
const CODEX_EVENTS = ["PreToolUse", "PostToolUse", "UserPromptSubmit"];
const TIMEOUTS = { PreToolUse: 10, PostToolUse: 10, PostToolUseFailure: 10, UserPromptSubmit: 5 };

export function targetFile(host, home = homedir()) {
  if (host === "claude") return join(home, ".claude", "settings.json");
  if (host === "codex") return join(home, ".codex", "hooks.json");
  throw new Error(`install target must be claude or codex (got ${host})`);
}

/** The hook command: absolute node and absolute cli path, so GUI-launched hosts without a shell PATH work. */
export function hookCommand(host, { node = process.execPath, cli } = {}) {
  return `"${node}" "${cli}" hook${host === "codex" ? " --agent codex" : ""}`;
}

function entryFor(host, event, command) {
  const hook = { type: "command", command, timeout: TIMEOUTS[event] ?? 10 };
  return event === "PreToolUse" || event === "PostToolUse" || event === "PostToolUseFailure" ? { matcher: ".*", hooks: [hook] } : { hooks: [hook] };
}

export function install(host, { home = homedir(), cli, node, registry, now = new Date() } = {}) {
  const file = targetFile(host, home);
  const cfg = readJson(file);
  cfg.hooks ??= {};
  const command = hookCommand(host, { node, cli });
  const events = host === "claude" ? CLAUDE_EVENTS : CODEX_EVENTS;
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  let backup = null;
  if (existsSync(file)) { backup = `${file}.jev-save.bak-${stamp}`; copyFileSync(file, backup); }
  const previous = readRegistry(registry).files[file]?.entries ?? {};
  const entries = {};
  for (const ev of events) {
    const mine = entryFor(host, ev, command);
    // drop what we recorded before (a re-install after moving the checkout), keep everything else, add ours once
    const others = (cfg.hooks[ev] ?? []).filter((g) => !sameEntry(g, mine) && !(previous[ev] && sameEntry(g, previous[ev])));
    cfg.hooks[ev] = [...others, mine];
    entries[ev] = mine;
  }
  // events we recorded earlier but no longer register (a manifest change): remove our old entry there too
  for (const ev of Object.keys(previous)) if (!(ev in entries) && Array.isArray(cfg.hooks[ev])) cfg.hooks[ev] = cfg.hooks[ev].filter((g) => !sameEntry(g, previous[ev]));
  writeJson(file, cfg);
  remember(file, entries, { path: registry, backup, at: now.toISOString() });
  return { file, backup, events };
}

export function uninstall(host, { home = homedir(), registry } = {}) {
  const file = targetFile(host, home);
  const recorded = readRegistry(registry).files[file];
  if (!recorded) return { file, removed: 0, note: "nothing recorded for this file; nothing removed" };
  const cfg = readJson(file);
  let removed = 0;
  for (const [ev, mine] of Object.entries(recorded.entries ?? {})) {
    if (!Array.isArray(cfg.hooks?.[ev])) continue;
    const before = cfg.hooks[ev].length;
    cfg.hooks[ev] = cfg.hooks[ev].filter((g) => !sameEntry(g, mine));
    removed += before - cfg.hooks[ev].length;
    if (!cfg.hooks[ev].length) delete cfg.hooks[ev];
  }
  if (cfg.hooks && !Object.keys(cfg.hooks).length) delete cfg.hooks;
  writeJson(file, cfg);
  forget(file, registry);
  return { file, removed, backup: recorded.backup ?? null };
}

/** Is our current command registered for every event we expect? For doctor. */
export function installed(host, { home = homedir(), cli, node } = {}) {
  const file = targetFile(host, home);
  const cfg = readJson(file);
  const command = hookCommand(host, { node, cli });
  const events = host === "claude" ? CLAUDE_EVENTS : CODEX_EVENTS;
  const present = events.filter((ev) => (cfg.hooks?.[ev] ?? []).some((g) => (g.hooks ?? []).some((h) => h.command === command)));
  return { file, present, missing: events.filter((ev) => !present.includes(ev)) };
}

function readJson(file) { if (!existsSync(file)) return {}; const text = readFileSync(file, "utf8"); return text.trim() ? JSON.parse(text) : {}; }
function writeJson(file, obj) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(obj, null, 2) + "\n"); }
