// `jev-save stats`: what the decision log says. Counts only; the measurement tools in tools/ do the rest.
import { readFileSync } from "node:fs";
import { DEFAULT_LOG } from "./core/log.js";

export function stats({ path = DEFAULT_LOG(), days, now = Date.now() } = {}) {
  let lines;
  try { lines = readFileSync(path, "utf8").split("\n").filter(Boolean); } catch { return `No decisions logged yet at ${path}.\nUse Claude Code or Codex with the hook installed, then re-run.`; }
  const cutoff = days ? now - days * 86_400_000 : 0;
  const rows = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((r) => r && r.at >= cutoff);
  if (!rows.length) return `No decisions in the last ${days} days at ${path}.`;
  const count = (f) => rows.filter(f).length;
  const judged = rows.filter((r) => r.provider);
  const lat = judged.map((r) => r.latency_ms).filter((x) => typeof x === "number").sort((a, b) => a - b);
  const q = (p) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * p))] : null);
  const byRule = {};
  for (const r of judged) if (r.advisory?.rule) byRule[r.advisory.rule] = (byRule[r.advisory.rule] ?? 0) + 1;
  const advised = count((r) => r.emitted === "context");
  const gated = count((r) => r.emitted === "deny" || r.emitted === "ask");
  const loggedOnly = count((r) => (r.fired ?? []).some((f) => /^security:.*:logged$/.test(f)));
  const sessions = new Set(rows.map((r) => r.session)).size;
  const out = [
    `${rows.length} decisions in ${sessions} sessions${days ? ` (last ${days} days)` : ""}, ${path}`,
    `  judged by Jev      ${judged.length}  (${count((r) => r.why === "read")} reads skipped, ${count((r) => r.why === "budget")} over budget, ${count((r) => r.why === "provider-error")} provider errors)`,
    `  decisions          ${["ALLOW", "ASK", "DENY", "SKIP"].map((d) => `${d} ${count((r) => r.decision === d)}`).join("  ")}`,
    `  advisories fired   ${Object.entries(byRule).map(([k, n]) => `${k} ${n}`).join("  ") || "none"}  (${count((r) => r.advisory?.suppressed)} suppressed, ${advised} sent to the agent)`,
    `  security gate      ${gated} deny/ask sent to the host, ${loggedOnly} recorded only (security=log or shadow)`,
    `  latency            p50 ${q(0.5) ?? "–"} ms, p90 ${q(0.9) ?? "–"} ms over ${lat.length} calls`,
    `  modes              shadow ${count((r) => r.mode === "shadow")}, advise ${count((r) => r.mode === "advise")}`,
  ];
  return out.join("\n");
}
