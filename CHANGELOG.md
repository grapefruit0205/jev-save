# Changelog

## jev-save

### Runtime evidence fixes (2026-09-21)
- Separate security coverage from efficiency heuristics: security `on`/`log` assesses all shell/MCP calls within explicit exclusions and the session budget. Narrowing `JEV_SAVE_JUDGE_KINDS` no longer narrows that coverage. Tighten cloud subcommand matching and classify shell substitutions, embedded programs and sort output writes conservatively.
- Honor shadow and security `log`/`off` on both provider errors and hook exceptions, even with `JEV_SAVE_FAIL_CLOSED` set.
- Never append without the ledger lock or steal a live writer's lock by age. A timeout/write failure marks session evidence uncertain; replace the timing-based lock test with a child-process handshake.
- Invalidate an earlier passing result after a later failed, unknown or unfinished run of the same action.
- Reserve provider invocation attempts before execution under the shared lock, including failures. Preserve the budget, original request and numbering through compaction, keeping append order even with nonmonotonic timestamps. Add multiprocess budget and compaction regressions.

### 0.1.0 — unreleased
- Forked from leepokai/jev-guard 0.3.1 at 94996ea. Renamed package, CLI, env prefix (`JEV_SAVE_*`), config dir (`~/.jev-save`).
- `TYPESAFE_API_KEY` accepted first; model pinned to `jev-1.13.0`.
- Dropped the jev-guard launch video and marketing assets.
- Stage 1: `src/core/evidence.js` (jev-belay's runner regex and output parsers, a segment-based shell classifier), `tools/extract-corpus.mjs`, `tools/baserate.mjs`; base rate recorded in `docs/baserate-2026-09-21.md`.
- Stage 2: append-only session ledger with execution lifecycle and a `valid / stale / unknown` validity signal; Jev question bundle (in_scope, necessary, redundant, scope_expansion, kind + jev-guard's security questions); pure policy with one advisory per call and suppression rules; answer cache; decision log; `DecisionProvider` seam with Jev and mock providers.
- Stage 3: Claude Code and Codex adapters, `jev-save hook`, plugin manifests (PreToolUse, PostToolUse, PostToolUseFailure, UserPromptSubmit), `install`/`uninstall` with backups and an exact registry, `doctor`, `mode`, `check --task`, `stats`. jev-guard's hook stays reachable as `hook --legacy` for the other hosts.
- First live run against `jev-1.13.0` (585–950 ms per call): a migration write and an unrelated refactor under "fix the login bug only" scored scope_expansion 0.97 / 0.90, an in-scope edit 0.13, a test file for the fix 0.27; `rm -rf /` risk 3 → deny; `git push --force` risk 2 → ask. Two adjustments from it: approval alone no longer asks below the risk threshold (the scope advisory owns that), and `vcs` / MCP write tools are judged for the security questions.

### After review of 70fb151 (2026-09-21)
- Shell classification no longer grants `read` by executable name: `aws`, `gh`, `curl`, `wget`, `docker`, `kubectl`, package managers and friends are read only for verified subcommands (`aws s3 ls`, `gh pr view`, `curl` without a method/body/output flag …); everything else they do is `external-write` (judged, security questions on) or a local write. `find -delete` is a write, `find -exec`, `eval`, `source` are scripts.
- Check outcomes need the host's word: a run with no runner summary is a pass only when the host confirmed success (Claude Code's PostToolUse vs PostToolUseFailure; a numeric exit code on Codex when present) and `unknown` otherwise — `npm test` ending in `Missing script` no longer counts as passing.
- Working directories are compared by a hash of the resolved path, not by the redacted display string; projects under `$HOME` keep their validity (redundant advisories were silently impossible there).
- Digests cover the whole tool input (canonical JSON): two edits of one file are two actions, and a shell command keeps its inner whitespace.
- Ledger appends take the compaction lock, so a compaction can no longer drop a line another process appended between its read and its rename; covered by a four-process test that loses events without the lock.

- `JEV_SAVE_JUDGE_KINDS` selects the kinds that are always judged (default unchanged). Measured on the author's corpus: the default judges 77% of calls, ≈3.5 min of waiting a day; a bash-first session can narrow it to `edit,check,vcs,external-write`.

- `jev-save security on|log|off` (`JEV_SAVE_SECURITY`, or `config.json`): `log` asks jev-guard's questions and records the verdict without sending deny/ask, so advise mode can be turned on early on a host that already runs a permission classifier. Policy evaluates the advisories even when a logged security verdict fired.

- Default model is `jev-latest` again: the API began rejecting `jev-1.13.0` by name on 2026-09-21 ("Unknown model") while its model list carries only the aliases; every judged call left the guard failing open. The version the alias resolves to (`model` in the response) is now recorded per decision and shown by `doctor` and `stats`.
- `stats` counts shadow-mode ask/deny as "recorded only".

## Upstream history (jev-guard, before the fork)

## 0.3.1 — 2026-09-18
- Jev calls retry on 429/5xx *and* network errors inside one time budget (`JEV_GUARD_TIMEOUT_MS`, 20 s), so a hook never outlives its host's ~30 s timeout and fail-closed actually fails closed.
- Instruction-file scans share one content-hash cache across the session-start sweep, `InstructionsLoaded`, `Read`/`Skill` results and `scan-skills`; cache hits carry only Jev's answer and the verdict is rebuilt.
- An answer with no `kind` is treated as serious instead of crashing the message builder; `JEV_GUARD_SKILL_P` / `JEV_GUARD_SKILL_SERIOUS_P` documented.

## 0.3.0 — 2026-09-18
- Context: every decision now sees the user's recent prompts, the agent's stated intent, recent decisions and flagged content (`src/context.js`, `src/session.js`). Two new questions: `user_requested` (turns ask into allow when the user asked for exactly that) and `from_untrusted` (denies a call that carries out an instruction planted in something the agent read). Prompt hooks on every host feed the memory; pi, OpenCode and ACP read the session directly.
- Instruction files: skills, plugins, rules and `CLAUDE.md`/`AGENTS.md` are checked with their own questions (`INSTRUCTION_QUESTIONS`) at session start, on `InstructionsLoaded`, when a `Skill` runs, when the agent reads one, and via `jev-guard scan-skills`; results cached by content hash.
- Third-party skill/plugin/MCP installs count as level-2 (ask) actions. Instruction-file thresholds: `JEV_GUARD_SKILL_P` (0.8, unrelated side effects) and `JEV_GUARD_SKILL_SERIOUS_P` (0.45, the serious kinds); answers cached by content hash and shared by the sweep and the read/Skill hooks.
- OpenCode: expose `main` and `exports["./server"]`, which is what OpenCode's npm plugin loader resolves; `"plugin": ["jev-guard"]` now works from the registry.
- `check` / `scan` exit 3 with a one-line error instead of a stack trace when Jev is unreachable.

## 0.2.0 — 2026-09-17
- Adapters for Copilot CLI, Gemini CLI, Cursor and OpenCode; the hook script recognises each host's payload.
- Marketplace manifests: Claude Code (`.claude-plugin`), Codex (`.agents/plugins`), Copilot (Claude layout), Gemini (`gemini-extension.json`, asks for the key on install), Cursor (`.cursor-plugin`).
- `jev-guard key` stores the API key in `~/.jev-guard/config.json` for hosts that don't inherit a shell.
- `install` writes the absolute `node` path and refuses to run from the npx cache.
- Icon, works-with strip and launch video.

## 0.1.0 — 2026-09-17
- First release: PreToolUse risk Score + approval Noul (deny / ask / allow), PostToolUse injection / canary scan; Claude Code and Codex hooks, pi extension, ACP proxy; TypeSafe API or Vercel AI Gateway backend.
