import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hookCommand, install, installed, targetFile, uninstall } from "../src/install/hosts.js";
import { readRegistry } from "../src/install/registry.js";

const fresh = () => mkdtempSync(join(tmpdir(), "jev-save-home-"));
const cli = "/opt/jev-save/src/cli.js", node = "/usr/bin/node";
const read = (f) => JSON.parse(readFileSync(f, "utf8"));

test("install: backs up, adds one entry per event, keeps other people's hooks, records what it wrote; idempotent", () => {
  const home = fresh(); const registry = join(home, "installed.json");
  const file = targetFile("claude", home);
  mkdirSync(join(home, ".claude"), { recursive: true });
  const theirs = { matcher: "Bash", hooks: [{ type: "command", command: "echo theirs" }] };
  writeFileSync(file, JSON.stringify({ permissions: { allow: ["Bash(ls)"] }, hooks: { PreToolUse: [theirs] } }));
  const r = install("claude", { home, cli, node, registry, now: new Date("2026-09-21T10:00:00Z") });
  assert.ok(r.backup.endsWith(".jev-save.bak-2026-09-21T10-00-00-000Z") && existsSync(r.backup));
  let cfg = read(file);
  assert.deepEqual(cfg.permissions, { allow: ["Bash(ls)"] });
  assert.deepEqual(cfg.hooks.PreToolUse[0], theirs);
  assert.equal(cfg.hooks.PreToolUse.length, 2);
  assert.equal(cfg.hooks.PreToolUse[1].hooks[0].command, hookCommand("claude", { node, cli }));
  assert.deepEqual(Object.keys(cfg.hooks).sort(), ["PostToolUse", "PostToolUseFailure", "PreToolUse", "UserPromptSubmit"]);
  assert.equal(cfg.hooks.UserPromptSubmit[0].hooks[0].timeout, 5);
  assert.ok(!("matcher" in cfg.hooks.UserPromptSubmit[0]));
  const reg = readRegistry(registry);
  assert.deepEqual(Object.keys(reg.files[file].entries).sort(), ["PostToolUse", "PostToolUseFailure", "PreToolUse", "UserPromptSubmit"]);
  install("claude", { home, cli, node, registry });
  cfg = read(file);
  assert.equal(cfg.hooks.PreToolUse.length, 2, "a second install does not duplicate");
  assert.equal(readdirSync(join(home, ".claude")).filter((f) => f.includes(".jev-save.bak-")).length, 2, "every install leaves a backup");
  assert.deepEqual(installed("claude", { home, cli, node }).missing, []);
  assert.equal(installed("claude", { home, cli: "/elsewhere/cli.js", node }).missing.length, 4);
});

test("install after the checkout moved replaces the old entry instead of adding a second", () => {
  const home = fresh(); const registry = join(home, "installed.json");
  install("codex", { home, cli: "/old/cli.js", node, registry });
  install("codex", { home, cli: "/new/cli.js", node, registry });
  const cfg = read(targetFile("codex", home));
  assert.equal(cfg.hooks.PreToolUse.length, 1);
  assert.match(cfg.hooks.PreToolUse[0].hooks[0].command, /\/new\/cli\.js" hook --agent codex$/);
  assert.deepEqual(Object.keys(cfg.hooks).sort(), ["PostToolUse", "PreToolUse", "UserPromptSubmit"]);
});

test("uninstall removes exactly the recorded entries, leaves everything else and the backups, and is safe to repeat", () => {
  const home = fresh(); const registry = join(home, "installed.json");
  const file = targetFile("claude", home);
  mkdirSync(join(home, ".claude"), { recursive: true });
  const theirs = { matcher: "Bash", hooks: [{ type: "command", command: "echo theirs" }] };
  const lookalike = { matcher: ".*", hooks: [{ type: "command", command: "echo jev-save-is-mentioned-here", timeout: 10 }] };
  writeFileSync(file, JSON.stringify({ env: { A: "1" }, hooks: { PreToolUse: [theirs, lookalike], Stop: [theirs] } }));
  const { backup } = install("claude", { home, cli, node, registry });
  const r = uninstall("claude", { home, registry });
  assert.equal(r.removed, 4);
  const cfg = read(file);
  assert.deepEqual(cfg, { env: { A: "1" }, hooks: { PreToolUse: [theirs, lookalike], Stop: [theirs] } });
  assert.ok(existsSync(backup));
  assert.equal(readRegistry(registry).files[file], undefined);
  assert.equal(uninstall("claude", { home, registry }).removed, 0);
});

test("uninstall without a record removes nothing", () => {
  const home = fresh(); const registry = join(home, "installed.json");
  const file = targetFile("codex", home);
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: [{ matcher: ".*", hooks: [{ type: "command", command: `"${node}" "${cli}" hook --agent codex`, timeout: 10 }] }] } }));
  const r = uninstall("codex", { home, registry });
  assert.equal(r.removed, 0);
  assert.equal(read(file).hooks.PreToolUse.length, 1);
});
