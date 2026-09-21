// Answer cache: the same model, the same question bundle and the same state give the same answers, so
// the API is not asked twice. Policy is re-evaluated on every hit, so threshold changes apply to cached
// answers. The key covers the *entire* state sent to Jev — recent_tool_calls included — so hits are rare
// by design; the cache exists for exact retries (a blocked call re-issued unchanged), not for savings.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { sessionPath } from "./ledger.js";

const MAX_ENTRIES = 100;

export function cacheKey(model, bundleVersion, state) {
  return createHash("sha256").update(`${model}\n${bundleVersion}\n${canonical(state)}`).digest("hex");
}

/** Deterministic JSON: object keys sorted at every level. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value ?? null);
}

export function cachePath(sessionId, dir) {
  return sessionPath(sessionId, dir).replace(/\.jsonl$/, ".cache.json");
}

export function readCache(sessionId, dir) {
  try { const c = JSON.parse(readFileSync(cachePath(sessionId, dir), "utf8")); return c && typeof c === "object" ? c : {}; } catch { return {}; }
}

export function lookup(sessionId, dir, key) {
  return readCache(sessionId, dir)[key]?.answers ?? null;
}

/** Best effort: two hooks writing at once lose an entry, never corrupt the file (temp + rename). */
export function store(sessionId, dir, key, answers, now = Date.now()) {
  try {
    const cache = readCache(sessionId, dir);
    cache[key] = { answers, at: now };
    const entries = Object.entries(cache).sort((a, b) => (b[1].at ?? 0) - (a[1].at ?? 0)).slice(0, MAX_ENTRIES);
    const path = cachePath(sessionId, dir);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(entries)), { mode: 0o600 });
    renameSync(tmp, path);
    return true;
  } catch { return false; }
}
