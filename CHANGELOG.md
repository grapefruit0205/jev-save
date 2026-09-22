# Changelog

## jev-save

### Shelved for interactive use; the README says what was found (2026-09-22)
- The author uninstalled the Claude Code hooks from the interactive sessions. Two days of live use, four unattended runs on three projects and a 30-day transcript replay are summarised in the README's "What we found", with a plain verdict: nothing to catch in an interactive session with a strong model; its place is unattended runs with a weaker model, where it spoke twice in 66 turns and was right both times.

### The request is tracked, not fixed (2026-09-22)
Every wrong scope advisory in the interactive log (9 of 9 labelled) came from measuring against the wrong text: a first prompt thirty turns old, a pasted document, a "부탁할게" whose content was in the assistant's message. Two earlier fixes (the current turn's prompt; the whole conversation) had failed on shorthand and on facts. This one asks Jev the thing it is good at — what a message *is* — and keeps the rest deterministic.
- At UserPromptSubmit the guard asks Jev `message_kind` (task / approval / paste / question / steer) and `refers_to_previous`, with the assistant's previous message from the transcript, and records a `prompt_kind` event. Replay folds them into a request state (`ledger.requestAfter`): a task or a paste replaces the request (plus the assistant message it points at), an approval makes the proposal the request, a steer appends (last two), a question changes nothing. `view.original_request` is that request; older ledgers and outages fall back to the first real prompt. Snapshots carry it through compaction.
- Validated offline on the three sessions that produced the labels (129 prompts, real tool inputs, live Jev): scope fired on 0 of the 9 wrong calls (2 under today's rule against the first prompt; all 9 under the rule of the day) and on 0 of 26 in-scope controls; in_scope on the wrong nine rose from a mean of 0.17 to 0.48, the authorised `terminate-instances` from 0.10 to 0.84. Pastes count as the request: the one case that stayed low (0.13) rose to 0.50 with that.
- Cost: one provider call per prompt, 0.7 s wall inside the hook (budget 3 s of the hook's 5), counted against the session budget. The decision log gets a `prompt` event per classification and each judgment records `view.request` (which request it was measured against).
- `<task-notification>` messages are synthetic.
- Measured, not built: retrieving an earlier user constraint at call time (for rules older than the tracker's two-steer window). On the corpus, 31 of 1,494 constraint × later-call pairs scored as violations; all were superseded turn-scoped instructions or injected CI notifications — 0 real. `<ci-monitor-event>` is synthetic now.
- Measured, not built: an over-design signal (request-implied size vs files and characters actually produced). On 30 days of transcripts only 18% of file-changing turns go through Edit/Write (the rest are shell and heredoc-script edits, opaque), and among those the 5 small-request/large-output cases were all legitimate; Jev's size reading misfires on document rewrites. docs/trial-2026-09-22.md.

### Repeats are the ledger's call; Jev judges the exception (2026-09-22)
Measured on a 66-turn headless run (`claude -p`, DeepSeek Flash as the actor, a plan-only copy of a Terraform repo): the agent ran `terraform plan` ten times, six of them for nothing, and the guard said nothing — every re-run wore a different pipe (`| tail -250`, `| grep Plan`, `| tail -8`), so the ledger saw ten different actions, and with the facts spelled out in the context Jev's `redundant` still answered 0.07–0.18. Replayed through this version with the real transcript and live Jev: the two wasted re-runs after a pass are advised, the two with a stated reason are lifted, nothing else fires.
- **Producer identity.** `evidence.actionDigestOf`: a shell command's identity for every "same action" question is what it produces — pipeline consumers (`tail`, `grep`, `jq`, `sed -n` …), label echoes and output redirects are dropped; flags, `cd`, environment assignments and heredoc bodies (hashed) are kept. The exact-input `digestOf` still keys the answer cache. Ledger `pre` events carry `action`; older ledgers fall back to `digest`.
- **Repeat rules read the ledger.** `redundant` fires on the ledger's facts alone — last run passed, nothing changed since, and re-running costs ≥ 5 s or ≥ 4 KB of output (`post` events now record `output_chars`) — and names the cost. New `repeat-failure`: the same action failed twice in a row with nothing changed in between (a possible fix ends the streak). Both have decision margin 1. The `redundant` question is gone from the bundle (v2).
- **Jev judges the exception.** `expects_new_information`, asked only when the call repeats one that ran: does the agent's own last narration give a concrete reason to expect a different result? At ≥ 0.8 the redundant advisory is lifted (trial: 0.85–0.90 on "the grep came back empty, let me see the whole output" and "credentials expired, let me refresh"; 0.19–0.24 without a reason). A third identical failure is called whatever was said.
- **The transcript closes what the hooks cannot.** On Claude Code the guard reads the tail of `transcript_path`: a permission denial fires no PostToolUse (PermissionDenied exists for auto mode only), so denied calls used to stay `running`, turn `unknown` and poison validity; they are now closed as `denied` (replayed as blocked: not a run, not a change). The same read supplies the narration. Nothing from the transcript is forwarded beyond the clipped, redacted narration.
- **Scope: a forbidden action, not only an added one.** in_scope ≤ 0.15 with approval ≥ 0.9 is a scope advisory (a commit against "no commits" scored 0.04 / 0.96 / expansion 0.44 on the trial's real context; the four other synthetic violations were already caught; 0 of 354 interactive decisions reach the clause).
- **Suppression fit for one long turn.** The advisory budget counts over the last 20 calls instead of per turn; the per-action cooldown is per finding (a repeat-failure after a redundant on the same action is new), five calls.
- Evidence: terraform's summary lines decide its outcome (`Planning failed.`, `Error:` with a `.tf` location → fail; `No changes.`, `Plan:`, `Success!` → pass) because `| tail` masks the exit status; an unfinished read no longer makes validity unknown (an unfinished change still counts as a change); a backtick or `$(` inside single quotes no longer makes a JMESPath query a script.
- Second headless run (click, Python, a planted one-line bug, `unittest`): 11 calls, one edit, both modules green, 0 advisories, 0 events. It exposed that Python `unittest` output had no parser — a failing module behind `| tail` was recorded as a pass, and a re-run without an edit would have drawn a wrong "ran this and passed" line. Added (`Ran N tests in …` then `OK` / `FAILED (…)`), with fixtures.
- Third project, a Go feature (a `config` subcommand for gravity-translate's companion), run twice: 16 and 19 calls, both minimal and inside the rules, 0 advisories; in_scope ≥ 0.83 and approval ≤ 0.54 on every edit, so the scope rule is far from legitimate feature work. One cheap post-pass re-run (Go's test cache, 0.6 s) left alone by the cost gate, as intended.
- Not built, measured out: a `known_information` question for "the same facts through a different command" scored 0.50 on the one real case and 0.14–0.44 on controls with the 120-character previews Jev gets — not separable.

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

### Orphaned ledger locks are reclaimed (2026-09-21)
- A lock left by a hook that died (the host killed it, or the API hung past its timeout) used to mark the session's evidence uncertain for good and stop every later judgment in it. The lock now records its owner's pid; a lock whose owner no longer exists, or that is older than 15 minutes (far past any hook's lifetime), is reclaimed on the next append. A lock whose owner may still be alive is still never stolen — the existing no-steal test keeps that guarantee. `doctor` reports held, orphaned and uncertain sessions.

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
