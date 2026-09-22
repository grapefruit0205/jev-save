<div align="center">
  <img src="assets/icon.svg" width="96" alt="jev-save">
  <h1>jev-save</h1>
  <p><strong>A runtime efficiency guard for coding agents, powered by <a href="https://typesafe.ai/">Jev</a>.</strong></p>
  <p>Before Claude Code or Codex runs a tool call, a session ledger says whether it repeats work already done, and Jev is asked whether it is still necessary, whether it widens what the user asked for, and — when it is a repeat — whether the agent gave a reason.</p>
  <p><a href="README.ko.md">한국어</a> · Built on <a href="https://github.com/leepokai/jev-guard">leepokai/jev-guard</a></p>
</div>

> **Status: 0.1.0, measured and shelved for interactive use.** Two days of live use, four unattended runs on three projects and a 30-day replay of the author's transcripts are summarised in [What we found](#what-we-found). Short version: it works, it is honest, and in an interactive session with a strong model there is nothing for it to catch. Its place is unattended runs with a weaker model. Read that section before installing.

## What it does

A coding agent's turn is a chain of tool calls: read, search, edit, run the tests, read again. Some of those calls do not need to happen. The same test suite is run again with nothing changed since it passed; the same file is read a third time; a bug fix quietly turns into a refactor, a new abstraction, a migration nobody asked for. Instruction files (`CLAUDE.md`, `AGENTS.md`) ask the model not to do these things, and long sessions forget them.

jev-save checks at the moment it matters — the host's `PreToolUse` hook, after the model has decided and before the tool runs — and answers with one short, fact-first line the agent sees before it acts:

```
jev-save: #12 ran this and passed; nothing observed changed since. Skip it unless you expect new information.
jev-save: this looks outside the request «fix the login bug, leave the DB alone» (scope p=0.91). Keep to the request, or ask the user before widening it.
jev-save: this call looks unlikely to move the request forward (necessary p=0.12). The last 9 calls were reads and searches with no edit; if you already know what to change, make the change.
```

Jev does not write code and does not plan. The coding model still decides how to solve the task; jev-save only says whether this next step is worth taking, and it never blocks an efficiency judgment. jev-guard's security questions (destructive commands, risky operations, instructions planted in untrusted content) ride along in the same request and keep their `deny` / `ask` behaviour.

Measured live on 2026-09-21 with `jev-1.13.0`, request *"fix the login bug only, leave the DB alone"*:

| Proposed call | scope_expansion | in_scope | risk | Result |
| --- | --- | --- | --- | --- |
| `Write db/migrations/0002_add_sessions_table.py` | 0.97 | 0.03 | 1.1 | scope advisory |
| `Edit src/billing/invoice.py` (rename an unrelated class) | 0.90 | 0.07 | 1.0 | scope advisory |
| `Edit src/auth.py` (the fix itself) | 0.13 | 0.78 | 1.0 | allowed, silent |
| `Write tests/test_auth_revoked.py` (a test for the fix) | 0.27 | 0.70 | 1.0 | allowed, silent |
| `pytest tests/test_auth.py -q` | 0.08 | 0.88 | 0.0 | allowed, silent |
| `git push --force origin main` | | | 2.0 | ask |
| `rm -rf /` | | | 3.0 | deny |

585–950 ms per judged call, about $0.00005 each.

## What we found

Everything below was measured, not guessed, over 2026-09-21/22. Details, tables and the raw numbers are in
[docs/trial-2026-09-22.md](docs/trial-2026-09-22.md); the design decisions each measurement forced are in
[docs/design.md](docs/design.md) and [CHANGELOG.md](CHANGELOG.md).

**What it is for.** Three kinds of waste: an agent that *loops* (re-runs a check that already passed, retries a
failing command without changing anything), an agent that *over-implements* (does work outside the request),
and an agent that *over-designs* (builds more structure than the request needs).

**What happened, in order.**

1. *Interactive use, one day, Opus, the author watching.* 310 tool calls judged. The guard spoke 13 times and was
   wrong 11 times (2 unlabelled). Every wrong line came from one cause: it measured the call against the wrong
   text — the session's first prompt thirty turns later, a pasted document, an approval ("부탁할게") whose
   content sat in the assistant's message. The events it exists to catch did not occur at all: the base rate of
   "the same passing check re-run with nothing changed" in the author's month of transcripts was 16 runs, about
   five minutes.
2. *Unattended run, Terraform drift audit, a weaker model (DeepSeek Flash) as the actor.* 66 turns, 65 calls.
   The agent ran `terraform plan` ten times; six of those could not produce anything new. The guard, as it then
   stood, said nothing — every re-run wore a different pipe (`| tail`, `| grep`), so the ledger saw ten actions,
   and Jev's `redundant` answer stayed at 0.07–0.18 even with the facts spelled out. Fixes that followed, each
   checked offline against the recording before it was written: the action's identity is what a command
   *produces* (pipes, echoes and redirects stripped); the repeat rules read the ledger only; Jev judges the one
   thing the ledger cannot — whether the agent stated a reason to expect something new (0.85–0.90 when it had,
   0.19–0.24 when it had not); denied calls are closed from the transcript instead of poisoning the evidence;
   terraform and Python `unittest` outputs are parsed because `| tail` hides their exit status. Replayed: two
   lines sent, both right; two lifted for a stated reason, both right; nothing else.
3. *Unattended run, a planted one-line bug in a Python project.* 11 calls, fixed cleanly, 0 advisories, 0 events.
4. *Unattended run, a small Go feature, twice.* 16 and 19 calls, both minimal and inside the rules, 0 advisories.
   On every edit `in_scope` stayed at 0.83 or above, so the scope rule is nowhere near legitimate feature work.
5. *Request tracking, validated on the interactive log.* Jev now says what each prompt *is* (task, approval,
   pasted material, question, steer), and the ledger keeps the request current from that. Replayed on the three
   sessions that produced the 11 labels (129 prompts, real inputs): the 9 wrong advisories go to 0, none of 26
   in-scope controls turn wrong. Cost 0.7 s per prompt.
6. *Over-design, base rate.* On 30 days of transcripts only 18% of file-changing turns go through Edit/Write (the
   rest are shell and script edits, invisible to any size rule); among those, every small-request/large-output
   case was legitimate. Not built.

**Across the three projects:** 90 judged calls in unattended runs, 2 lines sent, both on real waste, 0 wrong
lines, 0.6 s per judged call, 0 broken sessions.

**The verdict, plainly.**

| you are | install it? | why |
| --- | --- | --- |
| working interactively with a strong model, watching the screen | no | in 30 days of the author's sessions the events it catches did not happen; you pay 0.6 s per call and 0.7 s per prompt for silence, and you interrupt a loop faster than it can |
| running unattended jobs (`claude -p`, `codex exec`, a scheduled task), especially with a weaker model | yes, `advise` + `security log` | that is where loops happen, where nobody is watching, and where the request is one fixed text; it spoke twice in 66 turns there and was right both times |
| curious what your agent actually wastes | run `shadow` for a day and read `jev-save stats` | the ledger and the decision log are the useful artefact even when the advisories stay silent |

What did not work, and was removed or never built: a `redundant` question to Jev (it does not confirm the
ledger's facts), a `necessary` rule (never right anywhere), sending the whole conversation to Jev (right on
intent, wrong on facts), using the current turn's prompt as the request (breaks on shorthand and pastes),
a `known_information` question for the same facts through a different command (not separable), a size
signal for over-design (no events, 82% of edits invisible).

## How it works

```
user prompt ──► UserPromptSubmit hook ──► one Jev request: what is this message? ──► ledger: new turn, the request as it now stands
tool call   ──► PreToolUse hook ──────► classify ──► should Jev be asked? ──► one Jev request ──► policy ──► allow / advisory / ask / deny
tool result ──► PostToolUse hook ─────► ledger: outcome (pass / fail / unknown), duration, output size
```

**The ledger.** Every hook invocation is a separate process, so the session's memory is an append-only JSONL file per session under `~/.jev-save/sessions/`. It records each prompt, each proposed call (tool, kind, a redacted preview, paths) and each outcome, joined by the host's `tool_use_id`. A call whose result never arrived — the host was interrupted, a new prompt came first — is `unknown`, and `unknown` never counts as evidence. From this the guard derives, for the call in front of it: how many times the same action already ran this turn, what it returned last time and what that cost, what changed since the last passing run, whether that earlier pass is still *valid*, *stale* or *unknown*, and how many identical failures are stacked up with nothing changed between them.

"The same action" is the *producer*, not the exact command: `terraform plan | tail -250` and `terraform plan | grep "No changes"` are one action seen through two pipes (consumers, label echoes and output redirects are stripped; flags, `cd`, environment assignments and heredoc bodies are kept). The exact input still keys the answer cache.

**Which text is the request.** In a conversation the request is not the first prompt for ever. At each prompt Jev is asked one thing about the message itself — is it a *task*, an *approval* of what the assistant just proposed, pasted *material*, a *question*, or a *steer* — and whether it points at the assistant's previous message. A task (or a paste) replaces the request, together with the assistant message it refers to when it does; "부탁할게" after a proposal makes the proposal the request; a steer is appended to it; a question changes nothing. Every wrong scope advisory in the interactive log had come from measuring against the wrong text (a first prompt thirty turns old, a pasted document, an approval whose content was in the assistant's message); replayed with this tracking, the nine wrong ones went to zero and none of 26 in-scope controls turned wrong (docs/trial-2026-09-22.md). It costs one Jev call per prompt, about 0.7 s inside the UserPromptSubmit hook; when Jev is unavailable the prompt is recorded unclassified and the request stands.

On Claude Code the guard also reads the tail of the host's own transcript, for two things the hooks never deliver: the outcome of a call that fired no PostToolUse — a permission denial in `dontAsk` mode closes the entry as *never ran*, so it neither counts as a run nor as a change — and the agent's last words before the call, its stated reason.

**Classification is deterministic and offline.** Before any model is involved, the command is split into segments (heredoc bodies removed, quotes respected) and classified by its first word: a test/build/lint runner is a `check` (the runner regex and 26 runner-output parsers are vendored from [jev-belay](https://github.com/valentynkit/jev-belay)); `sed -i`, redirects, `rm`, package installs and git operations that touch the tree are writes; scripts and anything unrecognised count as changes, on purpose. Claude Code does not report a command's exit code, so a check's pass/fail comes from the runner's own summary line in its output.

**One Jev request per judged call.** Jev is TypeSafe's *System One* model: it takes a state and typed questions and returns probabilities, not prose, in a few hundred milliseconds. jev-save sends a projection of the call — the command clipped and redacted, an edit's path and the size of the change, never a file body or a patch — plus the user's request, the last few instructions, ten lines describing recent calls and their outcomes, and the ledger's counts. It asks, in the same request:

| id | type | question |
| --- | --- | --- |
| `in_scope` | yes/no | is this work that completing the request needs, including auxiliary work such as reading related code or adding a test for the change? |
| `necessary` | yes/no | given what was already done and learned, does this call move the request forward now? |
| `scope_expansion` | yes/no | does it introduce a new abstraction, an unrelated refactor, a migration, an extra feature, or an edit in an area the user excluded? |
| `kind` | choice | progress · verification · exploration · repetition · expansion |
| `message_kind`, `refers_to_previous` | choice, yes/no | at each prompt, not each call: task · approval · paste · question · steer, and does it point at the assistant's previous message? |
| `expects_new_information` | yes/no | only when the call repeats one that ran: does the agent's own last narration give a concrete reason to expect a different result — a suspected bad result, a changed input, a fix, another slice of a large output? |
| `risk`, `approval`, `user_requested` | jev-guard's | how much harm could it do; would a careful engineer want a human to confirm; did the user ask for exactly this? |

There is no `redundant` question any more. With the ledger's own facts in view — same producer, last run passed, nothing changed — Jev still answered 0.07–0.18 on a headless trial's plan re-runs, so whether a call is a repeat is decided from the ledger; what Jev decides is the exception.

**Policy is code, and pure.** Security first: risk 2.5+ denies, risk 1.5+ asks, and the user's own explicit request lifts an ask (never a deny). Then at most one advisory, by priority:

- *scope* — expansion ≥ 0.85, or in_scope ≤ 0.15 with expansion ≥ 0.5 (the two signals must agree, and there must be a request to measure against), or in_scope ≤ 0.15 with approval ≥ 0.9: a forbidden action rather than an added one (a commit against "no commits" scores in_scope 0.04, approval 0.96, expansion 0.44).
- *repeat-failure* — the ledger's fact: the same action already failed twice in a row with nothing changed in between. `#53 and #59 ran this and failed; nothing changed since. Fix the cause before running it again.`
- *redundant* — the ledger's fact: the last run of this action passed, nothing changed since, and re-running costs something (≥ 5 s or ≥ 4 KB of output). `#11 ran this (14 s) and passed; nothing changed since. If you need another part of its output, save it once instead of re-running.` Lifted when `expects_new_information` ≥ 0.8: "the grep came back empty, let me see the whole output" is a reason; "let me pull the ALB attributes next" is not.
- *necessary* — ≤ 0.20.

Suppression keeps it from nagging: the same finding on the same action once per five calls, three advisories per twenty calls, never two calls in a row. If the model reads an advisory and does the same thing anyway, jev-save stays silent — that may be a legitimate insistence.

**Security coverage is separate from efficiency classification.** With security `on` or `log`, every shell and MCP call is a judgment candidate, even if its name or command looks read-only. Shell classification is a heuristic, not a security boundary. Native read/search tools are judged when they repeat within a turn or the turn has already made 12 calls. With security `off`, shell and MCP calls also follow the selective efficiency rules. Explicit `JEV_SAVE_SKIP_TOOLS` exclusions and the session budget still apply.

**Cost is bounded.** A session stops asking after 200 provider invocation attempts by default. Each attempt is reserved under the ledger lock before the provider runs, including attempts that fail; concurrent hooks share the limit. Cache hits do not consume attempts, and HTTP retries inside one provider invocation share its reservation. The cache key includes the whole state and question bundle. Errors normally let the call through and are logged. `JEV_SAVE_FAIL_CLOSED` can deny security-bearing calls only with mode `advise` and security `on`; shadow mode and security `log`/`off` never deny on an error.

**Evidence stays conservative.** A later failure of the same action invalidates an earlier pass; a later unknown or unfinished run of it makes it uncertain; an unfinished change counts as a change, an unfinished read as nothing. A terraform run's verdict comes from its own summary lines, because `| tail` hides its exit status. Every ledger append and compaction uses the same lock. Compaction preserves the original request, total attempt count and sequence/turn numbering independently of the retained history. After a lock timeout or write failure, a `.jsonl.uncertain` marker makes validity unknown and disables new provider attempts for that session. Tools continue to run. Locks are never stolen based on age: after a crashed writer leaves an orphaned lock, start a new session; stop the host before manually cleaning up abandoned session files.

**Shadow or advise.** The shipped default records every judgment in `~/.jev-save/decisions.jsonl` and sends nothing to the agent; `jev-save mode advise` sends the advisories. Both log the same, so the log is the artefact either way. For an unattended run the measured setting is `advise` with `security log`: the security gate's `ask` would otherwise become a real permission prompt (a `sed -i` edit scored risk 1.7 live, and every `git commit` the user asked for scored 2.0), and hosts already run their own permission layer. For the runner that produced the numbers in [What we found](#what-we-found) — a copy of the repo, `claude -p --permission-mode dontAsk` with an allowlist, the guard in `advise` — see [docs/trial-2026-09-22.md](docs/trial-2026-09-22.md).

## Install

Requires Node 20.3+ and a TypeSafe key from [console.typesafe.ai/keys](https://console.typesafe.ai/keys). The key is written to `~/.jev-save/config.json` (mode 0600), sent only to `api.typesafe.ai`, and never given to the agent.

```bash
npm i -g jev-save                # or: git clone https://github.com/grapefruit0205/jev-save && cd jev-save
jev-save key "…"                 # or export TYPESAFE_API_KEY
jev-save install claude          # backs up ~/.claude/settings.json, adds four hooks, records exactly what it added
jev-save install codex           # same for ~/.codex/hooks.json; then trust the hooks with /hooks inside Codex
jev-save doctor                  # node, key, one Jev round trip, hook registration, state directories
```

As a plugin instead: `/plugin marketplace add grapefruit0205/jev-save` then `/plugin install jev-save@jev-save` in Claude Code; `codex plugin marketplace add grapefruit0205/jev-save` for Codex.

```bash
jev-save mode advise                          # turn advisories on (default: shadow, log only); every judgment is still logged
jev-save security log                         # keep jev-guard's deny/ask as a record only (Claude Code's own permission layer stays in charge)
jev-save check --task "fix login" Bash '{"command":"pytest -q"}'   # judge one call, print the signals
jev-save stats --days 7                       # what the decision log says
jev-save uninstall claude                     # removes only the entries install recorded; backups stay
JEV_SAVE_PROVIDER=mock jev-save check …       # the offline mock provider, no key needed
```

Claude Code picks the hooks up at once, even in a running session. Codex needs the hooks trusted in `/hooks` first.

| Variable | Default | Effect |
| --- | --- | --- |
| `JEV_SAVE_MODE` | `shadow` (or `config.json`) | `advise` sends advisories to the agent |
| `JEV_SAVE_SECURITY` | `on` (or `config.json`) | `log` asks the security questions and records the verdict but never sends deny/ask — for hosts that already run a permission classifier; `off` does not ask them. `jev-save security on\|log\|off` |
| `JEV_SAVE_ASK_SCORE` `JEV_SAVE_DENY_SCORE` | `1.5` `2.5` | jev-guard's risk thresholds; bash-first workflows may want `JEV_SAVE_ASK_SCORE=2` (a `sed -i` edit scored 1.7 live) |
| `JEV_SAVE_MAX_CALLS` | `200` | provider invocation attempts per session, including failures; preserved through compaction |
| `JEV_SAVE_LONG_TURN` | `12` | calls in a turn after which reads are judged too |
| `JEV_SAVE_TIMEOUT_MS` | `5000` | budget per Jev call, retries included |
| `JEV_SAVE_NECESSARY_P` `JEV_SAVE_EXPANSION_P` `JEV_SAVE_INSCOPE_P` `JEV_SAVE_REDUNDANT_P` | `0.20` `0.85` `0.15` `0.85` | advisory thresholds — experimental initial values |
| `JEV_SAVE_MAX_ADVISORIES` `JEV_SAVE_COOLDOWN_CALLS` | `3` `2` | per-turn budget, calls between advisories |
| `JEV_SAVE_CHECK` | | regex naming your own check command |
| `JEV_SAVE_JUDGE_KINDS` | `edit,write-bash,other,check,vcs,external-write` | efficiency kinds always judged; does not narrow security coverage. To apply selective efficiency rules to shell/MCP calls, set security `off` |
| `JEV_SAVE_SKIP_TOOLS` | | tool names never judged |
| `JEV_SAVE_FAIL_CLOSED` | unset | deny security-bearing calls on provider/hook errors only with mode `advise` and security `on`; `0`, `false`, `off`, `no` disable it |
| `JEV_MODEL` | `jev-latest` | the API accepts only its aliases (`jev-1.13.0` by name was rejected on 2026-09-21); the version actually served is recorded per decision, which is what keeps logs comparable |
| `JEV_SAVE_SESSIONS` `JEV_SAVE_LOG` `JEV_SAVE_CONFIG` | `~/.jev-save/…` | state locations |

## What leaves your machine

Only the Jev request: the tool name and a projection of its input (a shell command clipped to 2,000 characters and scrubbed of credential shapes; a file path with the size of an edit and its first 300 characters; a patch's file list and head), `cwd` with your home directory replaced by `~`, your last three prompts (1,500 characters at most), and ten one-line descriptions of recent calls with their outcomes. No file bodies, no tool output. The same redaction runs on everything written to the local log.

## Limits

- **Jev is a probabilistic model that reads untrusted text.** Its answers have a measured error rate, not a guarantee. jev-save is not a security sandbox; keep the host's own permission controls. The security questions come from jev-guard and inherit its calibration.
- **"Still valid" is an upper bound.** The ledger sees what the hooks see: edits made by you or by another process, dependency or environment changes and external services are invisible, which is why the redundancy judgment is advisory only and why enforcement is not in this version.
- **The thresholds are initial values.** They were chosen from a handful of live calls, not from a labeled corpus. Run shadow mode, label a sample, then decide.
- **Hosts differ.** Codex has no `ask`: a security ask becomes a deny that tells the model to get confirmation first. Codex reports a non-zero exit through `PostToolUse` and its exact `tool_response` shape for shell commands is unconfirmed; the runner parsers decide pass/fail from the output text.
- **Latency.** A judged call costs the Jev round trip plus a Node start, roughly 0.7 s in the initial measurements. Native reads/searches remain selective, but security `on`/`log` now covers all shell/MCP calls within the budget; earlier selective-classifier cost measurements no longer describe that default.

## Measuring

```bash
node tools/extract-corpus.mjs --days 30    # your Claude Code transcripts → corpus/turns.jsonl (redacted projection, stays local)
node tools/baserate.mjs                    # how much repeated verification and re-reading your sessions contain
jev-save stats --days 7                    # decisions, advisories fired and suppressed, latency, security gate
```

## Where the pieces come from

| Piece | Source |
| --- | --- |
| Jev client, Claude Code / Codex hook plumbing, security questions, key storage, the other hosts' adapters (`hook --legacy`) | [jev-guard](https://github.com/leepokai/jev-guard) (fork) |
| Test-runner detection, runner output parsers and their fixtures, redaction rules, the shadow-then-measure method | [jev-belay](https://github.com/valentynkit/jev-belay) (vendored) |
| Shell write/read/git classification, evaluation method (constant-guess baseline, harmful-hint rate) | [claude-jev](https://github.com/0x7067/claude-jev) |
| Question wording behind the runner parsers | [pi-warden](https://github.com/DevMortimer/pi-warden), via jev-belay |

Design notes, the stage plan, the verified host hook contracts and the base-rate measurement: [`docs/design.md`](docs/design.md), [`docs/baserate-2026-09-21.md`](docs/baserate-2026-09-21.md).

## Development

```bash
npm test          # node:test, offline (mock provider + jev-guard's fake fetch); no key needed
```

Layout: `src/core/` (evidence · ledger · context · questions · policy · cache · log · guard) · `src/providers/` (the `DecisionProvider` seam: jev, mock) · `src/adapters/` (claude, codex) · `src/save-hook.js` (the hook entry point) · `src/install/` (hosts, registry, doctor) · `tools/` (corpus, base rate) · jev-guard's own files stay where they were for the other hosts.

## License

MIT. `LICENSE` carries the upstream notices.
