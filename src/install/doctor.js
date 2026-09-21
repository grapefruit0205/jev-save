// `jev-save doctor`: is everything in place, and does Jev answer? Never prints a key.
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { backend, DEFAULT_MODEL, ask, readConfig } from "../jev.js";
import { DEFAULT_DIR } from "../core/ledger.js";
import { DEFAULT_LOG } from "../core/log.js";
import { settings } from "../core/guard.js";
import { installed } from "./hosts.js";

export async function doctor({ env = process.env, home = homedir(), cli, node, fetchImpl, live = true } = {}) {
  const rows = [];
  const ok = (label, good, detail = "") => rows.push({ label, good, detail });

  const major = Number(process.versions.node.split(".")[0]);
  ok("node", major >= 20, process.versions.node + (major >= 20 ? "" : " (need 20.3+)"));

  const s = settings(env, readConfig(env));
  ok("mode", true, `${s.mode}, security ${s.security === "on" ? "on (deny/ask sent to the host)" : s.security === "log" ? "log (recorded, never sent)" : "off"}, model ${s.model}`);

  const b = backend(env);
  ok("api key", Boolean(b), b ? `${b.kind} (from ${env.TYPESAFE_API_KEY || env.JEV_API_KEY || env.AI_GATEWAY_API_KEY || env.VERCEL_OIDC_TOKEN ? "environment" : "~/.jev-save/config.json"})` : "none: run `jev-save key <key>` or export TYPESAFE_API_KEY; the guard fails open until then");

  if (b && live) {
    const started = Date.now();
    try {
      const meta = {};
      const a = await ask("doctor", { alive: { type: "noul", instructions: "Is this a test request?" } }, { env, fetchImpl, timeoutMs: 8000, meta });
      ok("jev api", typeof a.alive?.p === "number", `${Date.now() - started} ms round trip, ${env.JEV_MODEL ?? DEFAULT_MODEL} → ${meta.model ?? "?"}`);
    } catch (err) { ok("jev api", false, String(err?.message ?? err)); }
  } else ok("jev api", false, b ? "skipped" : "no key");

  for (const host of ["claude", "codex"]) {
    const file = host === "claude" ? join(home, ".claude", "settings.json") : join(home, ".codex", "hooks.json");
    const hostPresent = existsSync(join(home, host === "claude" ? ".claude" : ".codex"));
    if (!hostPresent) { ok(`${host} hook`, true, `~/${host === "claude" ? ".claude" : ".codex"} not found: host not installed, nothing to do`); continue; }
    const st = installed(host, { home, cli, node });
    ok(`${host} hook`, st.missing.length === 0, st.missing.length ? `missing ${st.missing.join(", ")} in ${file}: run \`jev-save install ${host}\`` : `${st.present.length} events registered in ${file}`);
  }

  for (const [label, dir] of [["sessions dir", DEFAULT_DIR()], ["decision log", DEFAULT_LOG()]]) {
    try {
      let target = dir;
      while (!existsSync(target)) target = join(target, "..");   // the first existing ancestor decides writability
      accessSync(target, constants.W_OK);
      const size = existsSync(dir) && statSync(dir).isFile() ? ` (${(statSync(dir).size / 1024).toFixed(0)} KB)` : existsSync(dir) ? "" : " (will be created)";
      ok(label, true, dir + size);
    } catch { ok(label, false, `${dir} not writable`); }
  }
  return rows;
}

export function render(rows) {
  const width = Math.max(...rows.map((r) => r.label.length));
  return rows.map((r) => `${r.label.padEnd(width)}  ${r.good ? "✓" : "✗"}  ${r.detail}`).join("\n");
}
