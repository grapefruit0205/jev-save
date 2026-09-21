<div align="center">
  <img src="assets/icon.svg" width="96" alt="jev-save">
  <h1>jev-save</h1>
  <p><strong>A runtime efficiency guard for coding agents, powered by <a href="https://typesafe.ai/">Jev</a>.</strong></p>
  <p>Before Claude Code or Codex runs a tool call, Jev is asked whether the call is still necessary, whether it repeats a result that is still valid, and whether it widens what the user asked for.</p>
  <p><a href="README.ko.md">한국어</a> · Built on <a href="https://github.com/leepokai/jev-guard">leepokai/jev-guard</a></p>
</div>

> **Status: 0.1.0, shadow mode.** Everything runs end to end against the live Jev API; the advisory thresholds are experimental initial values that a week of shadow logs will re-set. Read [Limits](#limits) before trusting it with anything.

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

## How it works

```
user prompt ──► UserPromptSubmit hook ──► ledger: new turn, the request
tool call   ──► PreToolUse hook ──────► classify ──► should Jev be asked? ──► one Jev request ──► policy ──► allow / advisory / ask / deny
tool result ──► PostToolUse hook ─────► ledger: outcome (pass / fail / unknown), duration
```

**The ledger.** Every hook invocation is a separate process, so the session's memory is an append-only JSONL file per session under `~/.jev-save/sessions/`. It records each prompt, each proposed call (tool, kind, a redacted preview, paths) and each outcome, joined by the host's `tool_use_id`. A call whose result never arrived — the host was interrupted, a new prompt came first — is `unknown`, and `unknown` never counts as evidence. From this the guard derives, for the call in front of it: how many times the same action already ran this turn, what it returned last time, what changed since the last passing run, and whether that earlier pass is still *valid*, *stale* or *unknown*.

**Classification is deterministic and offline.** Before any model is involved, the command is split into segments (heredoc bodies removed, quotes respected) and classified by its first word: a test/build/lint runner is a `check` (the runner regex and 26 runner-output parsers are vendored from [jev-belay](https://github.com/valentynkit/jev-belay)); `sed -i`, redirects, `rm`, package installs and git operations that touch the tree are writes; scripts and anything unrecognised count as changes, on purpose. Claude Code does not report a command's exit code, so a check's pass/fail comes from the runner's own summary line in its output.

**One Jev request per judged call.** Jev is TypeSafe's *System One* model: it takes a state and typed questions and returns probabilities, not prose, in a few hundred milliseconds. jev-save sends a projection of the call — the command clipped and redacted, an edit's path and the size of the change, never a file body or a patch — plus the user's request, the last few instructions, ten lines describing recent calls and their outcomes, and the ledger's counts. It asks, in the same request:

| id | type | question |
| --- | --- | --- |
| `in_scope` | yes/no | is this work that completing the request needs, including auxiliary work such as reading related code or adding a test for the change? |
| `necessary` | yes/no | given what was already done and learned, does this call move the request forward now? |
| `redundant` | yes/no | does it repeat an action whose result is still valid, with no new information expected? |
| `scope_expansion` | yes/no | does it introduce a new abstraction, an unrelated refactor, a migration, an extra feature, or an edit in an area the user excluded? |
| `kind` | choice | progress · verification · exploration · repetition · expansion |
| `risk`, `approval`, `user_requested` | jev-guard's | how much harm could it do; would a careful engineer want a human to confirm; did the user ask for exactly this? |

**Policy is code, and pure.** Security first: risk 2.5+ denies, risk 1.5+ asks, and the user's own explicit request lifts an ask (never a deny). Then at most one advisory, by priority: *scope* (expansion ≥ 0.85, or in_scope ≤ 0.15 with expansion ≥ 0.5 — the two signals must agree, and there must be a request to measure against), *redundant* (≥ 0.85, and only when the ledger says the last pass is still valid), *necessary* (≤ 0.20). Suppression keeps it from nagging: one advisory per action per turn, three per turn, never two calls in a row. If the model reads an advisory and does the same thing anyway, jev-save stays silent — that may be a legitimate insistence.

**Cost is bounded.** Jev is asked about edits, shell writes, scripts, checks, commits/pushes and MCP tools with side effects; about reads and searches only when they repeat within a turn or the turn has already made 12 calls. A session stops asking after 200 calls. An answer cache keyed on the whole state handles exact retries. Every failure path — no key, a timeout, a malformed answer — lets the call through and writes one line to the log.

**Shadow first, but not for long.** The shipped default records every judgment in `~/.jev-save/decisions.jsonl` and sends nothing to the agent. Advise mode logs exactly the same, so switching early costs little: a wrong efficiency advisory is one line the agent can ignore, and the log still says what fired and whether the agent changed course. What a shadow period buys is a clean baseline without advisories, which the fixture A/B can supply later. The one thing to decide before switching is the security gate: its `ask` becomes a real permission prompt (a `sed -i` edit scored risk 1.7 live), so a host that already runs its own permission classifier should set `jev-save security log`.

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
| `JEV_SAVE_MAX_CALLS` | `200` | Jev calls per session |
| `JEV_SAVE_LONG_TURN` | `12` | calls in a turn after which reads are judged too |
| `JEV_SAVE_TIMEOUT_MS` | `5000` | budget per Jev call, retries included |
| `JEV_SAVE_NECESSARY_P` `JEV_SAVE_EXPANSION_P` `JEV_SAVE_INSCOPE_P` `JEV_SAVE_REDUNDANT_P` | `0.20` `0.85` `0.15` `0.85` | advisory thresholds — experimental initial values |
| `JEV_SAVE_MAX_ADVISORIES` `JEV_SAVE_COOLDOWN_CALLS` | `3` `2` | per-turn budget, calls between advisories |
| `JEV_SAVE_CHECK` | | regex naming your own check command |
| `JEV_SAVE_JUDGE_KINDS` | `edit,write-bash,other,check,vcs,external-write` | kinds always judged; bash-heavy sessions (one-off scripts, heredocs) can narrow it to `edit,check,vcs,external-write` — on the author's corpus the default judges 77% of calls, about 3.5 min of waiting a day |
| `JEV_SAVE_SKIP_TOOLS` | | tool names never judged |
| `JEV_SAVE_FAIL_CLOSED` | unset | deny (security-bearing calls, advise mode) when Jev is unreachable |
| `JEV_MODEL` | `jev-latest` | the API accepts only its aliases (`jev-1.13.0` by name was rejected on 2026-09-21); the version actually served is recorded per decision, which is what keeps logs comparable |
| `JEV_SAVE_SESSIONS` `JEV_SAVE_LOG` `JEV_SAVE_CONFIG` | `~/.jev-save/…` | state locations |

## What leaves your machine

Only the Jev request: the tool name and a projection of its input (a shell command clipped to 2,000 characters and scrubbed of credential shapes; a file path with the size of an edit and its first 300 characters; a patch's file list and head), `cwd` with your home directory replaced by `~`, your last three prompts (1,500 characters at most), and ten one-line descriptions of recent calls with their outcomes. No file bodies, no tool output. The same redaction runs on everything written to the local log.

## Limits

- **Jev is a probabilistic model that reads untrusted text.** Its answers have a measured error rate, not a guarantee. jev-save is not a security sandbox; keep the host's own permission controls. The security questions come from jev-guard and inherit its calibration.
- **"Still valid" is an upper bound.** The ledger sees what the hooks see: edits made by you or by another process, dependency or environment changes and external services are invisible, which is why the redundancy judgment is advisory only and why enforcement is not in this version.
- **The thresholds are initial values.** They were chosen from a handful of live calls, not from a labeled corpus. Run shadow mode, label a sample, then decide.
- **Hosts differ.** Codex has no `ask`: a security ask becomes a deny that tells the model to get confirmation first. Codex reports a non-zero exit through `PostToolUse` and its exact `tool_response` shape for shell commands is unconfirmed; the runner parsers decide pass/fail from the output text.
- **Latency.** A judged call costs the Jev round trip plus a Node start, roughly 0.7 s. Reads and searches are not judged by default for that reason.

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
