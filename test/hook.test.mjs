import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { detectAgent, handle, main } from "../src/save-hook.js";
import { toOutput as claudeOutput, toResult as claudeResult } from "../src/adapters/claude.js";
import { toOutput as codexOutput, toResult as codexResult } from "../src/adapters/codex.js";
import { readEvents, replay } from "../src/core/ledger.js";
import { mockProvider } from "../src/providers/mock.js";

const fresh = () => mkdtempSync(join(tmpdir(), "jev-save-hook-"));
const sid = "abc123";
const pre = (tool_name, tool_input, tool_use_id, extra = {}) => ({ hook_event_name: "PreToolUse", session_id: sid, cwd: "/repo", tool_name, tool_input, tool_use_id, ...extra });
const post = (tool_name, tool_input, tool_use_id, tool_response, extra = {}) => ({ hook_event_name: "PostToolUse", session_id: sid, cwd: "/repo", tool_name, tool_input, tool_use_id, tool_response, duration_ms: 1234, ...extra });

test("detectAgent: Codex payloads carry turn_id and model; --agent overrides", () => {
  assert.equal(detectAgent({}), "claude");
  assert.equal(detectAgent({ turn_id: "t", model: "gpt-5" }), "codex");
  assert.equal(detectAgent({ turn_id: "t", model: "gpt-5" }, ["--agent", "claude"]), "claude");
});

test("adapters: results from PostToolUse, PostToolUseFailure and Codex; outputs per host", () => {
  const ok = claudeResult(post("Bash", { command: "pytest" }, "u1", { stdout: "5 passed", stderr: "", interrupted: false, isImage: false }));
  assert.deepEqual(ok, { toolUseId: "u1", tool: "Bash", input: { command: "pytest" }, failed: false, interrupted: false, output: "5 passed\n", hostSuccess: true, durationMs: 1234 });
  const fail = claudeResult({ hook_event_name: "PostToolUseFailure", session_id: sid, tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "u2", error: "Exit code 1\nErr", is_interrupt: false, duration_ms: 10 });
  assert.equal(fail.failed, true); assert.equal(fail.output, "Exit code 1\nErr"); assert.equal(fail.interrupted, false);
  const abort = claudeResult({ hook_event_name: "PostToolUseFailure", session_id: sid, tool_name: "Bash", tool_input: {}, tool_use_id: "u3", error: "aborted", is_interrupt: true });
  assert.equal(abort.interrupted, true);
  const write = claudeResult(post("Write", { file_path: "/a" }, "u4", { filePath: "/a", type: "create" }));
  assert.equal(write.output, "/a", "structured results are flattened; the `type` key is skipped as in jev-guard's collectText");
  const cx = codexResult(post("Bash", { command: "pytest" }, "u5", { stdout: "", stderr: "1 failed", interrupted: false }));
  assert.equal(cx.failed, false, "Codex reports non-zero exits through PostToolUse without a status");
  assert.equal(cx.hostSuccess, null, "so the host said nothing");
  assert.equal(codexResult(post("Bash", { command: "npm test" }, "u6", { stdout: "", stderr: "Missing script", exit_code: 1 })).hostSuccess, false, "an exit code, when present, is the host's word");
  assert.equal(codexResult(post("Bash", { command: "npm test" }, "u7", { stdout: "", exitCode: 0 })).hostSuccess, true);
  assert.equal(codexResult(post("Bash", { command: "npm test" }, "u8", { stdout: "", metadata: { exit_code: 2 } })).failed, true);
  assert.equal(fail.hostSuccess, false);

  assert.equal(claudeOutput({ emit: null }), null);
  assert.deepEqual(claudeOutput({ emit: { kind: "deny", text: "no" } }), { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "no" } });
  assert.deepEqual(claudeOutput({ emit: { kind: "ask", text: "hm" } }), { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: "hm" } });
  assert.deepEqual(claudeOutput({ emit: { kind: "context", text: "hint" } }), { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "hint" } });
  const cxAsk = codexOutput({ emit: { kind: "ask", text: "hm" } });
  assert.equal(cxAsk.hookSpecificOutput.permissionDecision, "deny", "Codex has no ask");
  assert.match(cxAsk.hookSpecificOutput.permissionDecisionReason, /confirm/);
  assert.deepEqual(codexOutput({ emit: { kind: "context", text: "hint" } }), { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "hint" } });
});

test("handle: a whole turn through the hook, shadow then advise", async () => {
  const dir = fresh(); const logPath = join(dir, "d.jsonl");
  const provider = mockProvider();
  const o = (env = {}) => ({ agent: "claude", env, config: {}, provider, dir, logPath });
  assert.equal(await handle({ hook_event_name: "UserPromptSubmit", session_id: sid, prompt: "fix the login bug, leave the DB alone" }, o()), null);
  assert.equal(await handle(pre("Read", { file_path: "src/auth.py" }, "u1"), o()), null);
  assert.equal(await handle(post("Read", { file_path: "src/auth.py" }, "u1", { file: {}, type: "text" }), o()), null);
  assert.equal(await handle(pre("Edit", { file_path: "src/auth.py", old_string: "a", new_string: "b" }, "u2"), o()), null);
  assert.equal(await handle(post("Edit", { file_path: "src/auth.py" }, "u2", { filePath: "src/auth.py" }), o()), null);
  assert.equal(await handle(pre("Bash", { command: "pytest -q" }, "u3"), o()), null);
  assert.equal(await handle(post("Bash", { command: "pytest -q" }, "u3", { stdout: "===== 3 passed in 0.1s =====", stderr: "", interrupted: false }), o()), null);
  // the same check again: shadow logs the redundant advisory silently, advise emits it
  assert.equal(await handle(pre("Bash", { command: "pytest -q" }, "u4"), o()), null);
  await handle(post("Bash", { command: "pytest -q" }, "u4", { stdout: "===== 3 passed in 0.1s =====" }), o());
  const out = await handle(pre("Bash", { command: "pytest -q" }, "u5"), o({ JEV_SAVE_MODE: "advise" }));
  assert.match(out.hookSpecificOutput.additionalContext, /#4 ran this and passed/);
  // unknown events and missing session ids are ignored
  assert.equal(await handle({ hook_event_name: "Stop", session_id: sid }, o()), null);
  assert.equal(await handle(pre("Edit", {}, "u9", { session_id: "" }), o()), null);
  const entries = replay(readEvents(sid, dir)).entries;
  assert.deepEqual(entries.map((e) => [e.tool, e.decision, e.exec, e.result]), [
    ["Read", "SKIP", "completed", "pass"], ["Edit", "ALLOW", "completed", "pass"], ["Bash", "ALLOW", "completed", "pass"], ["Bash", "ALLOW", "completed", "pass"], ["Bash", "ALLOW", "running", null],
  ]);
  // the config file's mode applies when the environment says nothing
  const viaConfig = await handle(pre("Bash", { command: "pytest -q" }, "u6"), { ...o(), config: { mode: "advise" } });
  assert.equal(viaConfig, null, "already advised on this action this turn");
});

test("main: JSON in, JSON out; garbage in, nothing out; a provider failure is silent unless fail-closed", async () => {
  const dir = fresh();
  const run = async (payload, env = {}) => {
    const stdin = new PassThrough(); const stdout = new PassThrough(); let out = "";
    stdout.on("data", (d) => (out += d));
    const p = main(["--agent", "claude"], stdin, stdout, { JEV_SAVE_PROVIDER: "mock", JEV_SAVE_SESSIONS: dir, JEV_SAVE_LOG: join(dir, "d.jsonl"), JEV_SAVE_CONFIG: join(dir, "none.json"), ...env });
    stdin.end(typeof payload === "string" ? payload : JSON.stringify(payload));
    await p;
    return out;
  };
  assert.equal(await run("not json"), "");
  assert.equal(await run({ hook_event_name: "UserPromptSubmit", session_id: sid, prompt: "x" }), "");
  assert.equal(await run(pre("Edit", { file_path: "a", old_string: "a", new_string: "b" }, "m1")), "");
  const denied = JSON.parse(await run(pre("Bash", { command: "rm -rf /" }, "m2"), { JEV_SAVE_MODE: "advise" }));
  assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
  // Force an exception outside provider.decide: invalid path conversion in the action projection.
  const malformed = pre("Edit", { file_path: { toString: null } }, "bad");
  for (const [mode, security] of [["shadow", "on"], ["advise", "log"], ["advise", "off"]]) {
    assert.equal(await run(malformed, { JEV_SAVE_MODE: mode, JEV_SAVE_SECURITY: security, JEV_SAVE_FAIL_CLOSED: "1" }), "");
  }
  const failedClosed = JSON.parse(await run(malformed, { JEV_SAVE_MODE: "advise", JEV_SAVE_SECURITY: "on", JEV_SAVE_FAIL_CLOSED: "1" }));
  assert.equal(failedClosed.hookSpecificOutput.permissionDecision, "deny");
});
