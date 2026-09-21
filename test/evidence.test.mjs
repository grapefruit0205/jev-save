import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { actionOutcome, checkSummary, classifyAction, digestOf, previewOf, redact, runnerKind } from "../src/core/evidence.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "runners");
const fixtures = readdirSync(dir).filter((name) => name.endsWith(".txt")).sort();
const read = (name) => readFileSync(join(dir, name), "utf8");

test("belt 2 decides every runner fixture (vendored from jev-belay)", () => {
  assert.ok(fixtures.length > 40, "the zoo is there");
  for (const name of fixtures) {
    const expected = /-pass(\.doc)?\.txt$/.test(name) ? "pass" : "fail";
    assert.equal(checkSummary(read(name)), expected, name);
  }
});

test("a traceback that says error does not reach the compiler rule", () => {
  assert.equal(checkSummary(read("pytest-fail.txt")), "fail");
  const passingRunWithErrorText = [
    "test_parse (tests.test_x.ParseTest) ... ok",
    "error: connection reset, retrying",
    "============================== 5 passed in 0.31s ===============================",
  ].join("\n");
  assert.equal(checkSummary(passingRunWithErrorText), "pass");
  assert.equal(checkSummary("Some prose mentioning that Tests: 3 failed elsewhere\nnot a summary"), undefined);
});

const bash = (command) => classifyAction("Bash", { command }, {});
const kind = (command) => { const r = bash(command); return r.kind + (r.runner ? "/" + r.runner : ""); };

test("checks: a runner as the command's own verb, wherever it sits in the pipeline", () => {
  assert.equal(kind("pytest tests/test_auth.py -q"), "check/test");
  assert.equal(kind("cd repo && python3 -m pytest -q"), "check/test");
  assert.equal(kind(".venv/bin/python -m unittest tests.test_x -q"), "check/test");
  assert.equal(kind("PYTHONPATH=src .venv/bin/python -m ruff check ."), "check/lint");
  assert.equal(kind("npm test 2>&1 | tail -20"), "check/test");
  assert.equal(kind("npm run build"), "check/build");
  assert.equal(kind("cargo test"), "check/test");
  assert.equal(kind("go build ./..."), "check/build");
  assert.equal(kind("make test"), "check/test");
  assert.equal(kind("pytest > /dev/null 2>&1 && echo ok"), "check/test");
  assert.equal(runnerKind("npx eslint ."), "lint");
  assert.equal(runnerKind("cargo build"), "build");
  assert.equal(runnerKind("ls"), undefined);
});

test("a runner name inside a heredoc, a sed expression or a grep pattern is not a check", () => {
  assert.equal(kind("python3 - <<'EOF'\nimport pytest\nprint(1)\nEOF"), "write-bash");
  assert.equal(kind("cat <<'EOF' > x.py\nprint(1)\nEOF"), "write-bash");
  assert.equal(kind("sed -i 's/pytest/x/' a.py"), "write-bash");
  assert.equal(kind("grep -rn pytest src/"), "search");
  assert.equal(kind("git commit -m 'run pytest'"), "vcs");
});

test("writes, reads, searches, vcs and neutral commands", () => {
  assert.equal(kind("pytest > out.log"), "write-bash");
  assert.equal(kind("npm install"), "write-bash");
  assert.equal(kind("cargo add serde"), "write-bash");
  assert.equal(kind("make"), "write-bash");
  assert.equal(kind("git checkout -b x"), "write-bash");
  assert.equal(kind("git stash pop"), "write-bash");
  assert.equal(kind("git branch -d old"), "write-bash");
  assert.equal(kind("terraform apply -auto-approve"), "write-bash");
  assert.equal(kind("sed -n '1,20p' a.py"), "read");
  assert.equal(kind("cat a.py | head"), "read");
  assert.equal(kind("git status && git diff"), "read");
  assert.equal(kind("aws s3 ls"), "read");
  assert.equal(kind("echo hi > /tmp/a"), "read");
  assert.equal(kind("export FOO=1"), "read");
  assert.equal(kind("cd ~/x"), "read");
  assert.equal(kind("rg TODO"), "search");
  assert.equal(kind("git push origin main"), "vcs");
});

test("scripts and unknown commands count as changes", () => {
  assert.equal(kind("node -e 'console.log(1)'"), "other");
  assert.equal(kind("python3 -c 'print(1)'"), "other");
  assert.equal(kind("S=/tmp/x; python3 \"$S/a.py\""), "other");
  assert.equal(kind("./scripts/deploy.sh"), "other");
  assert.equal(kind(""), "other");
});

test("host tools: edits, reads, neutral, external, subagents", () => {
  const k = (tool) => classifyAction(tool, {}, {}).kind;
  assert.equal(k("Edit"), "edit"); assert.equal(k("Write"), "edit"); assert.equal(k("apply_patch"), "edit");
  assert.equal(k("Read"), "read"); assert.equal(k("Grep"), "search"); assert.equal(k("Glob"), "search");
  assert.equal(k("ToolSearch"), "read"); assert.equal(k("TodoWrite"), "read");
  assert.equal(k("WebFetch"), "external"); assert.equal(k("mcp__notion__notion-fetch"), "external"); assert.equal(k("mcp__x__list_items"), "external");
  assert.equal(k("mcp__notion__notion-create-pages"), "external-write"); assert.equal(k("mcp__gmail__send_message"), "external-write"); assert.equal(k("mcp__x__delete_record"), "external-write");
  assert.equal(k("mcp__shell__run"), "other"); assert.equal(k("mcp__fs__write_file"), "other"); assert.equal(k("Agent"), "other");
});

test("JEV_SAVE_CHECK names a project's own check command; a pattern matching the empty string is ignored", () => {
  assert.equal(classifyAction("Bash", { command: "./check.sh" }, { JEV_SAVE_CHECK: "^\\./check\\.sh" }).kind, "check");
  assert.equal(classifyAction("Bash", { command: "./check.sh" }, { JEV_SAVE_CHECK: ".*" }).kind, "other");
  assert.equal(classifyAction("Bash", { command: "./check.sh" }, { JEV_SAVE_CHECK: "(" }).kind, "other");
});

test("outcomes: summary beats the runner name, an interrupt is unknown, an edit passes unless the host errored", () => {
  assert.equal(actionOutcome("check", { output: read("pytest-fail.txt") }), "fail");
  assert.equal(actionOutcome("check", { output: read("pytest-pass.txt") }), "pass");
  assert.equal(actionOutcome("check", { failed: true, output: "" }), "fail");
  assert.equal(actionOutcome("check", { output: "" }), "pass");
  assert.equal(actionOutcome("check", { interrupted: true, output: read("pytest-pass.txt") }), "unknown");
  assert.equal(actionOutcome("edit", {}), "pass");
  assert.equal(actionOutcome("edit", { failed: true }), "fail");
});

test("digest is whitespace-insensitive for commands and ignores the tool name's case; preview is redacted", () => {
  assert.equal(digestOf("Bash", { command: "pytest  -q\n" }), digestOf("bash", { command: "pytest -q" }));
  assert.notEqual(digestOf("Bash", { command: "pytest -q" }), digestOf("Bash", { command: "pytest -q tests/a.py" }));
  assert.equal(digestOf("Read", { file_path: "/a", offset: 1 }) === digestOf("Read", { file_path: "/a", offset: 2 }), false);
  assert.equal(previewOf("Bash", { command: "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz' https://x" }, 200, "/home/u"), "curl -H 'Authorization: <redacted> https://x");   // belay's rule eats the closing quote too
  assert.equal(redact("token=abc123 at /home/u/proj", "/home/u"), "token=<redacted> at ~/proj");
});
