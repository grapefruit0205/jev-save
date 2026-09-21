// What a tool call *is* (a check, a read, a search, an edit, a shell write, or something we cannot
// classify) and what its result *says* (pass / fail / unknown). Everything here is deterministic and
// offline; Jev never sees this file's work, it sees the facts it produces.
//
// The runner-detection regex, the output parsers and the redaction rules are vendored verbatim from
// jev-belay (https://github.com/valentynkit/jev-belay, MIT, valentynkit), which in turn adapted the
// regex and question wording from pi-warden (https://github.com/DevMortimer/pi-warden, MIT). The shell
// write / read / git classification follows claude-jev's scripts/observed.py
// (https://github.com/0x7067/claude-jev, MIT, 0x7067).
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename } from "node:path";

// ---------------------------------------------------------------------------
// Redaction (jev-belay belay.mjs, "Redaction"). Broad on purpose: it runs on everything that leaves the
// machine or lands in a log.

const REDACTED = "<redacted>";
const SECRET_RULES = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, REDACTED],
  [/(authorization\s*[:=]\s*)(?:basic|bearer|token)?\s*\S+/gi, `$1${REDACTED}`],
  [/\b(bearer\s+)[\w.-]{16,}/gi, `$1${REDACTED}`],
  [/((?:api[_-]?key|apikey|access[_-]?key|secret[_-]?key|client[_-]?secret|private[_-]?key|passw(?:or)?d|passphrase|token|secret|credentials?)[a-z0-9_-]*["']?\s*[=:]\s*["']?)([^\s"'&;]+)/gi, `$1${REDACTED}`],
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]*:[^\s/@]+@/gi, `$1${REDACTED}@`],
  [/\bsk-[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\b[sr]k_(?:live|test)_[A-Za-z0-9]{10,}/g, REDACTED],
  [/\bnpm_[A-Za-z0-9]{30,}/g, REDACTED],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, REDACTED],
];

/** Scrub credentials and rewrite the home directory to `~`. */
export function redact(text, home = homedir()) {
  if (typeof text !== "string") return "";
  let out = text;
  for (const [pattern, replacement] of SECRET_RULES) out = out.replace(pattern, replacement);
  if (home) out = out.split(home).join("~");
  return out;
}

// ---------------------------------------------------------------------------
// Belt 1 (jev-belay / pi-warden src/done.ts:12): does the command text name a test, build, or lint runner?

export const CHECK_COMMAND = /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|check|lint|typecheck|build|verify|ci)\b|(?:npx|pnpm|bunx)\s+(?:tsc|jest|vitest|mocha|eslint|biome|prettier\s+--check)\b|pytest|jest|vitest|mocha|tsc|eslint|biome\s+check|ruff|mypy|flake8|pylint|black\s+--check|cargo\s+(?:test|check|build|clippy|nextest)|go\s+(?:test|vet|build)|make\s+(?:test|check|lint|build)|mvn\s+(?:test|verify)|gradle\w*\s+(?:test|check|build)|dotnet\s+(?:test|build)|node\s+--test|deno\s+(?:test|check|lint)|rspec|rake\s+test|mix\s+test|phpunit|swift\s+(?:test|build)|xcodebuild\s+test|ctest|zig\s+(?:test|build))\b/;

// Which kind of check a runner name implies. A `build` or `lint` pass says nothing about behaviour, so
// stop.js and validity.js treat only `test` as verification of a change.
const LINT_RUNNER = /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:lint|typecheck)|(?:npx|pnpm|bunx)\s+(?:tsc|eslint|biome|prettier\s+--check)|tsc|eslint|biome\s+check|ruff|mypy|flake8|pylint|black\s+--check|cargo\s+(?:check|clippy)|go\s+vet|make\s+(?:check|lint)|deno\s+(?:check|lint))\b/;
const BUILD_RUNNER = /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build|cargo\s+build|go\s+build|make\s+build|gradle\w*\s+build|dotnet\s+build|swift\s+build|zig\s+build)\b/;

/** @returns {'test'|'build'|'lint'|undefined} */
export function runnerKind(command) {
  if (typeof command !== "string" || !CHECK_COMMAND.test(command)) return undefined;
  if (LINT_RUNNER.test(command)) return "lint";
  if (BUILD_RUNNER.test(command)) return "build";
  return "test";
}

/**
 * The project's own check script, named by JEV_SAVE_CHECK as a regex over the command. A broken regex
 * is ignored rather than thrown, and so is one that matches the empty string (`.*` would make every
 * shell call a passing check). Compiled once per env object.
 */
const extraCache = new WeakMap();
export function extraCheck(env = process.env) {
  if (extraCache.has(env)) return extraCache.get(env);
  let pattern = null;
  try {
    const source = env.JEV_SAVE_CHECK;
    const re = source ? new RegExp(source) : null;
    pattern = re && !re.test("") ? re : null;
  } catch { pattern = null; }
  extraCache.set(env, pattern);
  return pattern;
}

// ---------------------------------------------------------------------------
// Belt 2 (jev-belay belay.mjs checkSummary, adapted from pi-warden src/done.ts:35-47): a runner launched
// from inside a script leaves no runner name in the command, but its output still carries its own
// summary. Returns what the summary reports, or undefined when there is no summary.

export function checkSummary(output) {
  if (typeof output !== "string" || !output) return undefined;
  const tail = output.slice(-6000).replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
  const nodeTest = /[ℹi] (?:tests|pass|fail) \d+/.test(tail) && /[ℹi] fail (\d+)/.exec(tail);
  if (nodeTest) return Number(nodeTest[1]) > 0 ? "fail" : "pass";
  const jest = /^Tests:\s+(?:(\d+) failed, )?.*?\d+ total/m.exec(tail);
  if (jest) return jest[1] && Number(jest[1]) > 0 ? "fail" : "pass";
  const pytest = /^=+ .*?(?:(\d+) failed|(\d+) error).*?in [\d.]+s/m.exec(tail) ?? /^=+ (\d+) passed.*? in [\d.]+s/m.exec(tail);
  if (pytest) return /\d+ (?:failed|error)/.test(pytest[0]) ? "fail" : "pass";
  const cargoOrGo = /^test result: (ok|FAILED)\./m.exec(tail) ?? /^(ok|FAIL)\s+\S+\s+[\d.]+s$/m.exec(tail);
  if (cargoOrGo) return cargoOrGo[1] === "ok" ? "pass" : "fail";
  const vitest = /^\s*Tests\s{2,}([^\n]*\(\d+\))\s*$/m.exec(tail);
  if (vitest) return /\d+ failed/.test(vitest[1]) ? "fail" : "pass";
  const bunFail = /^\s*(\d+) fail\s*$/m.exec(tail);
  if (bunFail && /^\s*\d+ pass\s*$/m.test(tail)) return Number(bunFail[1]) > 0 ? "fail" : "pass";
  const mix = /^(?:\d+ doctests?, )?\d+ tests?, (\d+) failures?/m.exec(tail);
  if (mix) return Number(mix[1]) > 0 ? "fail" : "pass";
  const dotnet = /^(Passed|Failed)!\s+-\s+Failed:\s+\d+/m.exec(tail);
  if (dotnet) return dotnet[1] === "Passed" ? "pass" : "fail";
  const build = /^(?:\[INFO\] )?BUILD (SUCCESSFUL|SUCCESS|FAILED|FAILURE)/m.exec(tail);
  if (build) return build[1].startsWith("SUCCESS") ? "pass" : "fail";
  const eslint = /^[✖x] \d+ problems? \((\d+) errors?/m.exec(tail);
  if (eslint) return Number(eslint[1]) > 0 ? "fail" : "pass";
  if (/\berror TS\d{4,}:/.test(tail)) return "fail";
  const nextest = /^\s*Summary \[[^\]]*\] \d+ tests run: [^\n]*/m.exec(tail);
  if (nextest) return /\d+ failed/.test(nextest[0]) ? "fail" : "pass";
  const deno = /^(ok|FAILED) \| \d+ passed[^|\n]*\| \d+ failed/m.exec(tail);
  if (deno) return deno[1] === "ok" ? "pass" : "fail";
  if (/^Found \d+ errors?\b/m.test(tail)) return "fail";
  if (/^(?:All checks passed!|Success: no issues found)/m.test(tail)) return "pass";
  const biome = /^Checked \d+ files? in [^\n]*/m.exec(tail);
  if (biome) return /\berrors?\b/.test(biome[0]) ? "fail" : "pass";
  if (/^\s*\d+ passing \(/m.test(tail)) return /^\s*\d+ failing\b/m.test(tail) ? "fail" : "pass";
  const rspec = /^\s*\d+ examples?, (\d+) failures?(?:, (\d+) errors? occurred outside of examples)?/m.exec(tail);
  if (rspec) return Number(rspec[1]) > 0 || Number(rspec[2] || 0) > 0 ? "fail" : "pass";
  const minitest = /^\s*\d+ runs?, \d+ assertions?, (\d+) failures?, (\d+) errors?/m.exec(tail);
  if (minitest) return Number(minitest[1]) > 0 || Number(minitest[2]) > 0 ? "fail" : "pass";
  if (/^FAILURES!/m.test(tail)) return "fail";
  if (/^OK \(\d+ tests?/m.test(tail)) return "pass";
  const swift = [...tail.matchAll(/^\s*Executed \d+ tests?, with (\d+) failures?/gm)];
  if (swift.length) return swift.some((m) => Number(m[1]) > 0) ? "fail" : "pass";
  const ctest = /^\d+% tests passed, (\d+) tests failed out of \d+/m.exec(tail);
  if (ctest) return Number(ctest[1]) > 0 ? "fail" : "pass";
  const playwrightFail = /^\s+\d+ failed\b/m.test(tail);
  if (playwrightFail || /^\s+\d+ passed \([\d.]+m?s\)\s*$/m.test(tail)) return playwrightFail ? "fail" : "pass";
  if (/^error\[E\d+\]: /m.test(tail) || /^error: could not compile /m.test(tail)) return "fail";
  if (/^\S+\.go:\d+:\d+: /m.test(tail)) return "fail";
  return undefined;
}

// ---------------------------------------------------------------------------
// Shell command classification. A bash-first workflow hides edits, searches and checks inside Bash, so the
// command string decides the category, not the tool name (claude-jev scripts/observed.py). The command is
// split into segments (heredoc bodies removed, quotes respected) and each segment is classified by its
// first word, so a runner name inside a heredoc script or a sed expression does not make it a check.

// Runners belay/pi-warden do not name but this corpus runs: python -m <runner>, unittest, tox/nox,
// pre-commit, and a few infra linters. Applied to a segment, not to the whole command.
const EXTRA_CHECK = /^(?:(?:python[0-9.]*|py)\s+-m\s+(?:pytest|unittest|ruff|mypy|pylint|flake8|black|coverage|tox|nox|pyright)\b|unittest\b|tox\b|nox\b|pyright\b|pre-commit\s+run\b|terraform\s+(?:validate|fmt\s+-check|plan)\b|tflint\b|cfn-lint\b|shellcheck\b|hadolint\b|ansible-lint\b|gradlew\s+(?:test|check|build)\b|composer\s+test\b|npm\s+run\s+(?:test|check|lint|typecheck|build|verify|ci)\S*)/;
const WRITE_HEAD = new Set(["rm", "mv", "cp", "mkdir", "rmdir", "touch", "patch", "tee", "install", "ln", "chmod", "chown", "truncate", "dd", "rsync", "unzip", "tar", "pip", "pip3", "uv", "poetry", "conda", "npm", "pnpm", "yarn", "bun", "cargo", "go", "gem", "bundle", "composer", "brew", "apt", "apt-get", "dnf", "yum", "docker", "kubectl", "helm", "terraform", "make"]);
const READ_HEAD = new Set(["cat", "head", "tail", "less", "more", "ls", "wc", "jq", "yq", "awk", "cut", "sort", "uniq", "stat", "file", "which", "tree", "column", "diff", "du", "df", "env", "printenv", "pwd", "date", "echo", "printf", "type", "realpath", "basename", "dirname", "true", "test", "[", "sleep", "whoami", "id", "uname", "hostname", "nproc", "free", "ps", "top", "md5sum", "sha256sum", "sha1sum", "base64", "od", "xxd", "hexdump", "strings", "tr", "nl", "tac", "rev", "seq", "expr", "bc", "curl", "wget", "ping", "dig", "nslookup", "gh", "aws", "gcloud", "az"]);
const SEARCH_HEAD = new Set(["grep", "rg", "ag", "find", "fd", "ack", "locate", "fzf"]);
const NEUTRAL_HEAD = new Set(["cd", "export", "set", "unset", "source", ".", "eval", "wait", "exit", "return", "trap", "shift", "local", "declare", "typeset", "readonly", "alias", "unalias", "pushd", "popd", "ulimit", "umask"]);
const WRAPPERS = new Set(["sudo", "time", "env", "nice", "nohup", "timeout", "command", "exec", "xargs", "watch", "caffeinate", "stdbuf", "unbuffer"]);
const GIT_READ_SUB = new Set(["log", "diff", "status", "show", "blame", "describe", "ls-files", "ls-tree", "rev-parse", "rev-list", "cat-file", "shortlog", "reflog", "grep", "branch", "tag", "remote", "config", "stash", "worktree", "fetch", "version", "help", "check-ignore", "for-each-ref", "name-rev", "merge-base"]);
const GIT_VCS_SUB = new Set(["commit", "add", "push", "notes", "rm", "mv"]);
// `git branch -d`, `git tag -d`, `git stash pop|apply|drop`, `git worktree add|remove`, `git remote add|set-url` change state.
const GIT_MUTATING_FLAGS = /^(?:branch\s+(?:-[dDmM]|--delete|--move)|tag\s+(?:-d|--delete)|stash\s+(?:pop|apply|drop|push|save|clear)|worktree\s+(?:add|remove|prune|move)|remote\s+(?:add|remove|rm|set-url|rename)|config\s+(?!--get|--list|-l\b)|fetch\s+.*--prune)/;

/** Remove heredoc bodies so words inside a script never classify the command. */
function stripHeredocs(command) {
  let out = "", i = 0, had = false;
  const lines = command.split("\n");
  while (i < lines.length) {
    const m = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(lines[i]);
    if (!m) { out += lines[i] + "\n"; i++; continue; }
    had = true;
    out += lines[i].slice(0, m.index) + " <<HEREDOC\n";
    const end = m[2];
    i++;
    while (i < lines.length && lines[i].replace(/^\t+/, "") !== end) i++;
    i++;
  }
  return { text: out, hadHeredoc: had };
}

/** Split on &&, ||, ;, |, newline outside quotes. Good enough for classification, not a parser. */
function splitSegments(text) {
  const segs = [];
  let cur = "", q = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { cur += ch; if (ch === q && text[i - 1] !== "\\") q = null; continue; }
    if (ch === "'" || ch === '"') { q = ch; cur += ch; continue; }
    if (ch === "\n" || ch === ";" || (ch === "&" && text[i + 1] === "&") || (ch === "|" && text[i + 1] === "|") || (ch === "|" && text[i + 1] !== "|")) {
      if (ch === "&" || (ch === "|" && text[i + 1] === "|")) i++;
      if (cur.trim()) segs.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) segs.push(cur.trim());
  return segs;
}

/** First real word of a segment: env assignments, wrappers and paths stripped. */
function headOf(segment) {
  let s = segment.replace(/^\(+\s*/, "").replace(/^\{\s*/, "");
  for (;;) {
    const m = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S*)\s+)/.exec(s);
    if (!m) break;
    s = s.slice(m[0].length);
  }
  const words = s.split(/\s+/);
  let idx = 0;
  while (idx < words.length && WRAPPERS.has(basename(words[idx]).toLowerCase())) idx++;
  const raw = words[idx] ?? "";
  const head = basename(raw).toLowerCase();
  return { head, rest: words.slice(idx + 1).join(" "), body: [head, ...words.slice(idx + 1)].join(" "), rawHead: raw };
}

const REDIRECT = /(?<![0-9&<])>>?\s*(?!&)(\S+)/g;

/** @returns {'check'|'read'|'search'|'write'|'vcs'|'neutral'|'other'} with runner for checks */
function classifySegment(segment, env) {
  const { head, rest, body } = headOf(segment);
  if (!head) return { kind: "neutral" };
  if (NEUTRAL_HEAD.has(head)) return { kind: "neutral" };
  // a redirect to a real file is a write, whatever the command; /dev/null and /tmp are not the tree
  for (const m of body.matchAll(REDIRECT)) { const target = m[1]; if (!/^(\/dev\/null|\/tmp\/|\$\{?S(?:P|CRATCH)?\b)/.test(target)) return { kind: "write" }; }
  if (head === "sed") return /(^|\s)-[a-zA-Z]*i/.test(rest) ? { kind: "write" } : { kind: "read" };
  if (head === "git") {
    const sub = rest.trim().split(/\s+/)[0] ?? "";
    if (GIT_MUTATING_FLAGS.test(rest.trim())) return { kind: "write" };
    if (GIT_READ_SUB.has(sub)) return { kind: "read" };
    if (GIT_VCS_SUB.has(sub)) return { kind: "vcs" };
    return { kind: "write" };   // checkout, switch, reset, rebase, merge, pull, restore, clean, apply, am, clone …
  }
  if (SEARCH_HEAD.has(head)) return { kind: "search" };
  if (READ_HEAD.has(head)) return { kind: "read" };
  if (CHECK_COMMAND.test(body) || EXTRA_CHECK.test(body) || extraCheck(env)?.test(segment) === true) {
    // `npm install`, `cargo add`, `go get`, `pip install` share a head with runners; the runner regexes
    // only match the verb forms, so a package-manager segment that did not match above is a write.
    return { kind: "check", runner: runnerKind(body) ?? (/(?:lint|typecheck|ruff|mypy|pylint|flake8|black|pyright|tflint|cfn-lint|shellcheck|hadolint|ansible-lint|terraform\s+(?:validate|fmt))\b/.test(body) ? "lint" : /\b(?:build)\b/.test(body) ? "build" : "test") };
  }
  if (WRITE_HEAD.has(head)) return { kind: "write" };
  if (head === "python" || head === "python3" || head === "node" || head === "ruby" || head === "perl" || head === "php" || head === "bash" || head === "sh" || head === "zsh") {
    return { kind: "other" };   // a script: could do anything, so it counts as a change
  }
  return { kind: "other" };
}

const MCP_READ_VERBS = new Set(["get", "list", "search", "fetch", "read", "query", "find", "describe", "status", "show", "lookup", "check", "view", "count", "resolve", "validate"]);
const EDIT_TOOLS = new Set(["edit", "write", "multiedit", "notebookedit", "apply_patch"]);
const READ_TOOLS = new Set(["read", "notebookread", "read_file", "read_many_files"]);
const SEARCH_TOOLS = new Set(["grep", "glob", "search_file_content", "grep_search", "list_directory", "ls"]);
// Host tools that touch neither the tree nor its inputs: planning, UI, tool discovery.
const NEUTRAL_TOOLS = new Set(["todowrite", "todoread", "askuserquestion", "exitplanmode", "enterplanmode", "toolsearch", "skill", "senduserfile", "schedulewakeup", "listagents", "sendmessage", "listskills", "reportfindings", "write_todos"]);
// Things that reach outside the machine but do not change the working tree.
const EXTERNAL_TOOLS = new Set(["webfetch", "websearch", "web_fetch", "google_web_search", "artifact", "notebookread"]);

/**
 * @typedef {'check'|'read'|'search'|'edit'|'write-bash'|'vcs'|'external'|'external-write'|'other'} ActionKind
 * `check`      a test/build/lint runner (or the JEV_SAVE_CHECK pattern) as a command's own verb
 * `read`, `search`, `external`  no change to the tree or its inputs, and no side effect
 * `vcs`, `external-write`       no change to the tree, but a side effect (commit/push, an MCP create/send/delete)
 * `edit`       a host edit tool;  `write-bash`  a shell command that writes
 * `other`      a script, a subagent, an MCP shell/filesystem tool — the ledger counts it as a change, on purpose.
 */

/** @returns {{kind: ActionKind, runner?: 'test'|'build'|'lint', command?: string}} */
export function classifyAction(tool, input = {}, env = process.env) {
  const name = String(tool ?? "").toLowerCase();
  if (EDIT_TOOLS.has(name)) return { kind: "edit" };
  if (READ_TOOLS.has(name)) return { kind: "read" };
  if (SEARCH_TOOLS.has(name)) return { kind: "search" };
  if (NEUTRAL_TOOLS.has(name)) return { kind: "read" };
  if (EXTERNAL_TOOLS.has(name)) return { kind: "external" };
  if (name.startsWith("mcp__")) {
    if (/shell|exec|command|run|write_file|edit_file|filesystem|\bfs\b|git/.test(name)) return { kind: "other" };            // may touch the tree: a change
    const words = name.split(/[_\-.]+/);   // underscores are word characters to \b, so tokenize by hand
    if (words.some((w) => MCP_READ_VERBS.has(w))) return { kind: "external" };
    return { kind: "external-write" };   // create, update, send, delete, post … outside the tree, but a side effect worth the security questions
  }
  if (name !== "bash" && name !== "shell") return { kind: "other" };   // Agent/Task, Workflow, unknown tools
  const command = typeof input?.command === "string" ? input.command : "";
  if (!command.trim()) return { kind: "other", command };
  const { text, hadHeredoc } = stripHeredocs(command);
  const kinds = splitSegments(text).map((s) => classifySegment(s, env));
  const has = (k) => kinds.some((c) => c.kind === k);
  if (kinds.length && kinds.every((c) => c.kind === "neutral")) return { kind: "read", command };   // cd, export, set …
  const check = kinds.find((c) => c.kind === "check");
  if (has("write") || (hadHeredoc && !check)) return { kind: "write-bash", command };
  if (has("other")) return { kind: "other", command };
  if (check) return { kind: "check", runner: check.runner, command };
  if (has("vcs")) return { kind: "vcs", command };
  if (has("search")) return { kind: "search", command };
  if (has("read")) return { kind: "read", command };
  return { kind: "other", command };
}

/**
 * The verdict of a finished check. Claude Code records a runner's nonzero exit with no exit code (its
 * Bash result carries stdout, stderr, interrupted, isImage only), so belt 2 speaks before belt 1: a
 * summary that says "fail" wins, `failed` (host error / interrupt) wins, a named runner with a clean
 * summary or no summary at all is a pass, and a check we could not read is `unknown`.
 * @returns {'pass'|'fail'|'unknown'}
 */
export function checkOutcome({ failed = false, interrupted = false, output = "" } = {}) {
  if (interrupted) return "unknown";
  const summary = checkSummary(output);
  if (summary === "fail" || failed) return "fail";
  if (summary === "pass") return "pass";
  return failed ? "fail" : "pass";
}

/** Outcome of any action from its result envelope. Edits and reads pass unless the host reported an error. */
export function actionOutcome(kind, { failed = false, interrupted = false, output = "" } = {}) {
  if (kind === "check") return checkOutcome({ failed, interrupted, output });
  if (interrupted) return "unknown";
  return failed ? "fail" : "pass";
}

// ---------------------------------------------------------------------------
// Identity: "is this the same action as before?" Compared, never used as the execution key
// (that is the host's tool_use_id).

const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

export function pathsOf(tool, input = {}) {
  const name = String(tool ?? "").toLowerCase();
  const p = input?.file_path ?? input?.path ?? input?.filePath ?? input?.notebook_path;
  if (EDIT_TOOLS.has(name) || READ_TOOLS.has(name)) return p ? [String(p)] : [];
  if (name === "apply_patch") return [];
  return [];
}

/** Stable identity of an action for repeat detection. */
export function digestOf(tool, input = {}) {
  const name = String(tool ?? "").toLowerCase();
  let identity;
  if (name === "bash" || name === "shell" || name === "apply_patch") identity = norm(input?.command);
  else if (EDIT_TOOLS.has(name)) identity = norm(input?.file_path ?? input?.path ?? input?.filePath);
  else if (name === "read" || name === "notebookread") identity = `${norm(input?.file_path ?? input?.path)}:${input?.offset ?? ""}:${input?.limit ?? ""}`;
  else if (name === "grep") identity = `${norm(input?.pattern)}|${norm(input?.path)}|${norm(input?.glob)}|${norm(input?.type)}`;
  else if (name === "glob") identity = `${norm(input?.pattern)}|${norm(input?.path)}`;
  else identity = norm(JSON.stringify(input ?? {}));
  return createHash("sha256").update(`${name}\n${identity}`).digest("hex").slice(0, 16);
}

/** Short, redacted, human-readable line for logs and Jev state. Never file contents. */
export function previewOf(tool, input = {}, max = 120, home = homedir()) {
  const name = String(tool ?? "").toLowerCase();
  let s;
  if (name === "bash" || name === "shell") s = input?.command;
  else if (EDIT_TOOLS.has(name) || READ_TOOLS.has(name)) s = input?.file_path ?? input?.path ?? input?.filePath ?? "";
  else if (name === "grep") s = `${input?.pattern ?? ""} ${input?.path ?? ""}`;
  else if (name === "glob") s = `${input?.pattern ?? ""} ${input?.path ?? ""}`;
  else s = input?.url ?? input?.query ?? input?.description ?? "";
  return redact(norm(s), home).slice(0, max);
}

/** Basename-only view of a path list, for corpus files that must not carry repository layout. */
export const shortPaths = (paths) => paths.map((p) => basename(p));
