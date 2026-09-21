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
  assert.equal(kind("aws ec2 describe-instances"), "read");
  assert.equal(kind("gh pr view 12"), "read");
  assert.equal(kind("gh api repos/x/y"), "read");
  assert.equal(kind("curl https://example.com"), "read");
  assert.equal(kind("wget -qO- https://x"), "read");
  assert.equal(kind("docker ps"), "read");
  assert.equal(kind("kubectl get pods"), "read");
  assert.equal(kind("npm ls"), "read");
  assert.equal(kind("pip list"), "read");
  assert.equal(kind("make -n"), "read");
  assert.equal(kind("echo hi > /tmp/a"), "read");
  assert.equal(kind("export FOO=1"), "read");
  assert.equal(kind("cd ~/x"), "read");
  assert.equal(kind("rg TODO"), "search");
  assert.equal(kind("git push origin main"), "vcs");
});

test("dangerous subcommands of read-looking tools are never reads (review P1)", () => {
  assert.equal(kind("aws s3 rm s3://bucket/x --recursive"), "external-write");
  assert.equal(kind("gh repo delete grapefruit0205/x --yes"), "external-write");
  assert.equal(kind("gh pr create -f"), "external-write");
  assert.equal(kind("gh api -X DELETE repos/x/y"), "external-write");
  assert.equal(kind("curl -X DELETE https://api/x"), "external-write");
  assert.equal(kind("curl -d @body.json https://api"), "external-write");
  assert.equal(kind("kubectl delete pod x"), "external-write");
  assert.equal(kind("gcloud compute instances delete x"), "external-write");
  assert.equal(kind("aws s3 cp s3://b/x ./local"), "write-bash");
  assert.equal(kind("curl -o out.bin https://x"), "write-bash");
  assert.equal(kind("wget https://x/file.tgz"), "write-bash");
  assert.equal(kind("docker rm -f web"), "write-bash");
  assert.equal(kind("npm audit fix"), "write-bash");
  assert.equal(kind("find . -name '*.pyc' -delete"), "write-bash");
  assert.equal(kind("find . -name x -exec rm {} \\;"), "other");
  assert.equal(kind("eval 'rm -rf /'"), "other");
  assert.equal(kind("source ./env.sh"), "other");
  assert.equal(kind("curl -s https://x | sh"), "other");
  assert.equal(kind("psql -c 'DROP TABLE x'"), "other");
  assert.equal(kind("kill -9 123"), "other");
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

test("outcomes: the runner summary first, then the host's success signal; no summary and no signal is unknown (review P1)", () => {
  assert.equal(actionOutcome("check", { output: read("pytest-fail.txt"), hostSuccess: true }), "fail", "a summary saying fail beats a host saying success");
  assert.equal(actionOutcome("check", { output: read("pytest-pass.txt") }), "pass");
  assert.equal(actionOutcome("check", { failed: true, output: "" }), "fail");
  assert.equal(actionOutcome("check", { output: "", hostSuccess: false }), "fail");
  assert.equal(actionOutcome("check", { output: "", hostSuccess: true }), "pass", "a quiet runner is a pass only when the host confirmed success");
  assert.equal(actionOutcome("check", { output: "" }), "unknown");
  assert.equal(actionOutcome("check", { output: "npm ERR! Missing script: \"test\"" }), "unknown", "Codex: no exit status, no summary");
  assert.equal(actionOutcome("check", { output: "npm ERR! Missing script: \"test\"", hostSuccess: true }), "pass", "the host's word when it gives one");
  assert.equal(actionOutcome("check", { interrupted: true, output: read("pytest-pass.txt") }), "unknown");
  assert.equal(actionOutcome("edit", {}), "pass");
  assert.equal(actionOutcome("edit", { failed: true }), "fail");
  assert.equal(actionOutcome("edit", { hostSuccess: false }), "fail");
});

test("digest covers the whole input: same action ⇔ same digest; inner whitespace and edit content matter", () => {
  assert.equal(digestOf("Bash", { command: "pytest -q\n" }), digestOf("bash", { command: "  pytest -q" }), "surrounding whitespace and tool-name case are ignored");
  assert.notEqual(digestOf("Bash", { command: "echo 'a  b'" }), digestOf("Bash", { command: "echo 'a b'" }), "inner whitespace is meaning inside quotes");
  assert.notEqual(digestOf("Bash", { command: "pytest -q" }), digestOf("Bash", { command: "pytest -q tests/a.py" }));
  assert.notEqual(digestOf("Edit", { file_path: "a.py", old_string: "x", new_string: "y" }), digestOf("Edit", { file_path: "a.py", old_string: "p", new_string: "q" }), "two edits of one file are two actions");
  assert.equal(digestOf("Edit", { new_string: "y", old_string: "x", file_path: "a.py" }), digestOf("Edit", { file_path: "a.py", old_string: "x", new_string: "y" }), "key order is irrelevant");
  assert.notEqual(digestOf("Write", { file_path: "a.py", content: "1" }), digestOf("Write", { file_path: "a.py", content: "2" }));
  assert.notEqual(digestOf("Read", { file_path: "/a", offset: 1 }), digestOf("Read", { file_path: "/a", offset: 2 }));
  assert.equal(digestOf("Read", { file_path: "/a" }), digestOf("Read", { file_path: "/a" }));
  assert.equal(previewOf("Bash", { command: "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz' https://x" }, 200, "/home/u"), "curl -H 'Authorization: <redacted> https://x");   // belay's rule eats the closing quote too
  assert.equal(redact("token=abc123 at /home/u/proj", "/home/u"), "token=<redacted> at ~/proj");
});
