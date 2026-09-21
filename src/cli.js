#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "src", "cli.js");
const [cmd, ...rest] = process.argv.slice(2);

const USAGE = `jev-save — runtime efficiency guard for coding agents, powered by Jev (built on jev-guard)

  jev-save hook [--agent codex]          Command hook (JSON on stdin → JSON on stdout) for Claude Code and Codex
  jev-save check [--task "…"] <tool> '<json>'   Judge one tool call in a throwaway session (--task: the user request to judge against)
  jev-save mode [shadow|advise]          Show or set the mode (shadow: log only; advise: send advisories to the agent)
  jev-save install claude|codex          Back up the host's user config, add jev-save's hooks, record what was added
  jev-save uninstall claude|codex        Remove exactly the entries install recorded; backups stay
  jev-save doctor                        Node, key, one Jev round trip, hook registration, state directories
  jev-save key <api key>                 Save the key to ~/.jev-save/config.json (0600); vck_… keys are
                                          treated as Vercel AI Gateway keys, anything else as TypeSafe
  jev-save stats [--days N]              Summarize the decision log (see tools/ for measurement)

Inherited from jev-guard, for other hosts (not covered by jev-save's efficiency judgments):
  jev-save hook --legacy [--agent …]     jev-guard's hook (Copilot, Gemini, Cursor payloads)
  jev-save acp -- <agent command...>     ACP proxy
  jev-save scan [file] · scan-skills     prompt-injection scans
  jev-save install copilot|gemini|cursor|pi|opencode

Credentials are read from TYPESAFE_API_KEY / JEV_API_KEY / AI_GATEWAY_API_KEY / VERCEL_OIDC_TOKEN first, then from that file.`;

switch (cmd) {
  case "hook": {
    if (rest.includes("--legacy")) { const { main } = await import("./hook.js"); await main(rest.filter((a) => a !== "--legacy")); break; }
    const { main } = await import("./save-hook.js");
    await main(rest);
    break;
  }
  case "check": {
    const { assess, recordPrompt } = await import("./core/guard.js");
    const { selectProvider } = await import("./providers/provider.js");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const taskAt = rest.indexOf("--task");
    const task = taskAt >= 0 ? rest[taskAt + 1] : "";
    const args = taskAt >= 0 ? [...rest.slice(0, taskAt), ...rest.slice(taskAt + 2)] : rest;
    if (!args[0]) die("check needs a tool name and a JSON input");
    let input = {};
    try { input = args[1] ? JSON.parse(args[1]) : {}; } catch (e) { die(`input is not JSON: ${e.message}`); }
    const dir = mkdtempSync(join(tmpdir(), "jev-save-check-"));
    const env = { ...process.env, JEV_SAVE_MODE: "advise", JEV_SAVE_LONG_TURN: "0" };   // judge even a first read
    const sessionId = `check-${process.pid}`;
    if (task) recordPrompt(sessionId, task, { dir });
    const provider = await selectProvider(env);
    const r = await assess({ agent: "claude", tool: args[0], input, cwd: process.cwd(), sessionId, toolUseId: "check" }, { provider, env, dir, logPath: join(dir, "decisions.jsonl") }).catch((e) => die(`${e.message} (exit 3)`, 3));
    if (r.error) die(`${r.error} (exit 3)`, 3);
    const lines = [`${r.decision}${r.emit ? `  ${r.emit.kind}` : ""}  (${r.cls.kind}${r.cls.runner ? "/" + r.cls.runner : ""}, ${r.judged ? `${provider.name}${r.cached ? ", cached" : ""}${r.latencyMs != null ? `, ${r.latencyMs} ms` : ""}` : "not judged"})`];
    if (Object.keys(r.signals).length) lines.push(`signals  ${Object.entries(r.signals).map(([k, v]) => `${k}=${v}`).join("  ")}`);
    if (r.advisory) lines.push(`advisory ${r.advisory.rule}${r.advisory.suppressed ? ` (suppressed: ${r.advisory.why})` : ""}: ${r.advisory.text}`);
    if (r.reason) lines.push(`reason   ${r.reason}`);
    console.log(lines.join("\n"));
    process.exitCode = r.decision === "DENY" ? 2 : r.decision === "ASK" ? 1 : 0;
    break;
  }
  case "mode": {
    const { CONFIG_FILE, readConfig } = await import("./jev.js");
    const want = rest[0];
    if (!want) { console.log(`mode: ${process.env.JEV_SAVE_MODE ?? readConfig().mode ?? "shadow"}${process.env.JEV_SAVE_MODE ? " (from JEV_SAVE_MODE)" : ""}`); break; }
    if (want !== "shadow" && want !== "advise") die("mode must be shadow or advise");
    const cfg = { ...readConfig(), mode: want };
    mkdirSync(dirname(CONFIG_FILE), { recursive: true, mode: 0o700 });
    writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
    console.log(`jev-save: mode ${want} saved to ${CONFIG_FILE}${process.env.JEV_SAVE_MODE ? ` (JEV_SAVE_MODE=${process.env.JEV_SAVE_MODE} in this shell overrides it)` : ""}`);
    break;
  }
  case "install": {
    if (rest[0] === "claude" || rest[0] === "codex") {
      if (ROOT.includes("/_npx/") || ROOT.includes("\\_npx\\")) die("running from the npx cache, which gets pruned; install with `npm i -g jev-save` (or git clone) and run install from there");
      const { install } = await import("./install/hosts.js");
      const r = install(rest[0], { cli: CLI });
      console.log(`jev-save: ${r.events.length} hooks written to ${r.file}${r.backup ? `\nbackup: ${r.backup}` : ""}${rest[0] === "codex" ? "\nRun /hooks inside Codex to trust them." : ""}`);
      await keyHint();
      break;
    }
    legacyInstall(rest[0]);
    break;
  }
  case "uninstall": {
    if (rest[0] !== "claude" && rest[0] !== "codex") die("uninstall target must be claude or codex");
    const { uninstall } = await import("./install/hosts.js");
    const r = uninstall(rest[0]);
    console.log(`jev-save: removed ${r.removed} entr${r.removed === 1 ? "y" : "ies"} from ${r.file}${r.note ? ` (${r.note})` : ""}${r.backup ? `\nthe pre-install backup is still at ${r.backup}` : ""}`);
    break;
  }
  case "doctor": {
    const { doctor, render } = await import("./install/doctor.js");
    const rows = await doctor({ cli: CLI, live: !rest.includes("--offline") });
    console.log(render(rows));
    process.exitCode = rows.every((r) => r.good) ? 0 : 1;
    break;
  }
  case "stats": {
    const { stats } = await import("./stats.js");
    console.log(stats({ days: rest.includes("--days") ? Number(rest[rest.indexOf("--days") + 1]) : undefined }));
    break;
  }
  case "acp": {
    const args = rest[0] === "--" ? rest.slice(1) : rest;
    if (!args.length) die("acp needs an agent command after --");
    const { runProxy } = await import("./acp.js");
    runProxy(args[0], args.slice(1));
    break;
  }
  case "scan": {
    const { scanContent } = await import("./guard.js");
    const text = rest[0] ? readFileSync(rest[0], "utf8") : readFileSync(0, "utf8");
    const r = await scanContent({ text, tool: "scan", source: rest[0] }).catch((e) => die(`${e.message} (exit 3)`, 3));
    console.log(r ? `${r.flagged ? "FLAGGED" : "CLEAN"}  ${r.message}` : "SKIPPED  too short to scan");
    process.exitCode = r?.flagged ? 2 : 0;
    break;
  }
  case "scan-skills": {
    const { findInstructionFiles, projectRoots, scanFiles, userRoots } = await import("./skills.js");
    const roots = rest.length ? rest.map((r) => resolve(r)) : [...userRoots(), ...projectRoots()];
    const files = findInstructionFiles(roots);
    if (!files.length) { console.log("jev-save: no instruction files found"); break; }
    process.stderr.write(`jev-save: scanning ${files.length} instruction files…\n`);
    const results = await scanFiles(files);
    const flagged = results.filter((r) => r.flagged), errors = results.filter((r) => r.error);
    for (const r of flagged) console.log(`FLAGGED  ${r.file}\n         ${r.kind.replace("_", " ")} p=${r.p}${r.cached ? " (cached)" : ""}`);
    for (const r of errors) console.log(`ERROR    ${r.file}: ${r.error}`);
    console.log(`${results.length} scanned (${results.filter((r) => r.cached).length} cached), ${flagged.length} flagged, ${errors.length} errors`);
    process.exitCode = flagged.length ? 2 : errors.length ? 3 : 0;
    break;
  }
  case "key": {
    const { CONFIG_FILE, readConfig } = await import("./jev.js");
    const key = rest.find((a) => !a.startsWith("--"));
    if (!key) die("key needs the API key as an argument");
    const gateway = rest.includes("--gateway") || key.startsWith("vck_");
    const cfg = { ...readConfig(), [gateway ? "aiGatewayApiKey" : "jevApiKey"]: key };
    mkdirSync(dirname(CONFIG_FILE), { recursive: true, mode: 0o700 });
    writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
    console.log(`jev-save: ${gateway ? "Vercel AI Gateway" : "TypeSafe"} key saved to ${CONFIG_FILE}`);
    break;
  }
  default:
    console.log(USAGE);
    process.exitCode = cmd ? 1 : 0;
}

// jev-guard's installer for the hosts jev-save does not cover itself (unchanged upstream behaviour).
function legacyInstall(target) {
  if (ROOT.includes("/_npx/") || ROOT.includes("\\_npx\\")) die("running from the npx cache, which gets pruned; install with `npm i -g jev-save` (or git clone) and run install from there");
  const cmd = (extra = "") => `"${process.execPath}" "${CLI}" hook --legacy${extra}`;
  const notOurs = (list) => (list ?? []).filter((g) => !JSON.stringify(g).includes(CLI));
  const home = homedir();
  let file, cfg, note = "";
  switch (target) {
    case "copilot": {
      file = join(home, ".copilot", "hooks", "jev-save.json");
      cfg = { version: 1, hooks: {} };
      for (const ev of ["PreToolUse", "PostToolUse", "UserPromptSubmit", "SessionStart"]) cfg.hooks[ev] = [{ type: "command", bash: cmd(" --agent copilot"), timeoutSec: 30 }];
      break;
    }
    case "gemini": {
      file = join(home, ".gemini", "settings.json");
      cfg = readJson(file);
      cfg.hooks ??= {};
      const entry = { hooks: [{ name: "jev-save", type: "command", command: cmd(), timeout: 30_000 }] };
      for (const ev of ["BeforeTool", "AfterTool", "BeforeAgent", "SessionStart"]) cfg.hooks[ev] = [...notOurs(cfg.hooks[ev]), entry];
      break;
    }
    case "cursor": {
      file = join(home, ".cursor", "hooks.json");
      cfg = readJson(file);
      cfg.version ??= 1;
      cfg.hooks ??= {};
      const add = (ev, extra = {}) => (cfg.hooks[ev] = [...notOurs(cfg.hooks[ev]), { command: cmd(), timeout: 30, ...extra }]);
      add("beforeShellExecution"); add("beforeMCPExecution"); add("preToolUse", { matcher: "Write|Delete" }); add("postToolUse");
      add("beforeSubmitPrompt"); add("sessionStart");
      break;
    }
    case "pi": {
      file = join(home, ".pi", "agent", "settings.json");
      cfg = readJson(file);
      const ext = join(ROOT, "extensions", "jev-save.ts");
      cfg.extensions = [...(cfg.extensions ?? []).filter((p) => p !== ext), ext];
      break;
    }
    case "opencode": {
      file = join(home, ".config", "opencode", "plugins", "jev-save.js");
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `export { JevSave } from ${JSON.stringify(join(ROOT, "src", "opencode.js"))};\n`);
      note = 'For approval prompts, set "permission": { "bash": "ask" } in opencode.json; jev-save then auto-approves the safe calls.';
      console.log(`jev-save: plugin shim written to ${file}${note ? "\n" + note : ""}`);
      keyHint();
      return;
    }
    default:
      die("install target must be one of claude, codex (jev-save) or copilot, gemini, cursor, pi, opencode (jev-guard's hook)");
  }
  writeJson(file, cfg);
  console.log(`jev-save: written to ${file}${note ? "\n" + note : ""}`);
  keyHint();
}

async function keyHint() {
  const { backend } = await import("./jev.js");
  if (!backend()) console.log("No API key found yet: run `jev-save key <key>` (or export TYPESAFE_API_KEY / AI_GATEWAY_API_KEY). Until then the guard fails open.");
}

function readJson(file) { return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {}; }
function writeJson(file, obj) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(obj, null, 2) + "\n"); }
function die(msg, code = 1) { console.error(`jev-save: ${msg}${code === 1 ? `\n\n${USAGE}` : ""}`); process.exit(code); }
