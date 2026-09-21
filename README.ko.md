<div align="center">
  <img src="assets/icon.svg" width="96" alt="jev-save">
  <h1>jev-save</h1>
  <p><strong>코딩 에이전트를 위한 runtime 효율 guard. <a href="https://typesafe.ai/">Jev</a>로 판단합니다.</strong></p>
  <p>Claude Code나 Codex가 tool call을 실행하기 직전에, 그 호출이 지금 필요한지, 아직 유효한 결과를 반복하는지, 사용자가 부탁한 범위를 넓히는지를 Jev에게 묻습니다.</p>
  <p><a href="README.md">English</a> · <a href="https://github.com/leepokai/jev-guard">leepokai/jev-guard</a> 기반</p>
</div>

> **상태: 0.1.0, shadow 모드.** 실제 Jev API까지 끝에서 끝까지 동작합니다. 권고 임계값은 실험용 초기값이며, 일주일치 shadow 로그로 다시 정합니다. 무엇이든 맡기기 전에 [한계](#한계)를 먼저 읽어 주세요.

## 무엇을 하는가

코딩 에이전트의 한 턴은 tool call의 연쇄입니다. 읽고, 검색하고, 고치고, 테스트를 돌리고, 다시 읽습니다. 그중 일부는 굳이 일어날 필요가 없는 호출입니다. 통과한 뒤 아무것도 바뀌지 않았는데 같은 테스트를 다시 돌리고, 같은 파일을 세 번째 읽고, 버그 수정이 조용히 리팩터링과 새 추상화와 아무도 부탁하지 않은 migration으로 번집니다. `CLAUDE.md`나 `AGENTS.md`에 하지 말라고 적어 두어도 긴 세션은 잊습니다.

jev-save는 그 순간에 검사합니다. 모델이 결정을 내린 뒤, 도구가 실행되기 전인 호스트의 `PreToolUse` hook에서요. 그리고 에이전트가 행동하기 전에 볼 수 있도록 사실을 앞세운 짧은 한 줄을 돌려줍니다.

```
jev-save: #12 ran this and passed; nothing observed changed since. Skip it unless you expect new information.
jev-save: this looks outside the request «로그인 버그만 고쳐. DB는 건드리지 마.» (scope p=0.91). Keep to the request, or ask the user before widening it.
jev-save: this call looks unlikely to move the request forward (necessary p=0.12). The last 9 calls were reads and searches with no edit; if you already know what to change, make the change.
```

Jev는 코드를 쓰지 않고 계획도 세우지 않습니다. 어떻게 풀지는 여전히 코딩 모델이 정하고, jev-save는 이 다음 한 걸음이 밟을 가치가 있는지만 말합니다. 효율 판단은 실행을 막지 않습니다. jev-guard에서 물려받은 보안 질문(파괴적인 명령, 위험한 작업, 신뢰할 수 없는 내용에 심긴 지시)은 같은 요청에 함께 실려 원래대로 `deny`와 `ask`를 냅니다.

2026-09-21에 `jev-1.13.0`으로 실측한 결과입니다. 요청은 "로그인 버그만 고쳐. DB는 건드리지 마."였습니다.

| 제안된 호출 | scope_expansion | in_scope | risk | 결과 |
| --- | --- | --- | --- | --- |
| `Write db/migrations/0002_add_sessions_table.py` | 0.97 | 0.03 | 1.1 | scope 권고 |
| `Edit src/billing/invoice.py` (무관한 클래스 이름 변경) | 0.90 | 0.07 | 1.0 | scope 권고 |
| `Edit src/auth.py` (수정 자체) | 0.13 | 0.78 | 1.0 | 허용, 침묵 |
| `Write tests/test_auth_revoked.py` (수정에 대한 테스트) | 0.27 | 0.70 | 1.0 | 허용, 침묵 |
| `pytest tests/test_auth.py -q` | 0.08 | 0.88 | 0.0 | 허용, 침묵 |
| `git push --force origin main` | | | 2.0 | ask |
| `rm -rf /` | | | 3.0 | deny |

판단 한 번에 585~950ms, 비용은 약 $0.00005입니다.

## 어떻게 동작하는가

```
사용자 프롬프트 ──► UserPromptSubmit hook ──► ledger: 새 턴, 요청 기록
tool call      ──► PreToolUse hook ──────► 분류 ──► Jev에 물을 호출인가? ──► Jev 요청 한 번 ──► 정책 ──► allow / 권고 / ask / deny
tool 결과       ──► PostToolUse hook ─────► ledger: 결과(pass / fail / unknown), 소요 시간
```

**ledger.** hook은 호출마다 별도 프로세스로 뜨므로, 세션의 기억은 `~/.jev-save/sessions/` 아래 세션당 하나인 append-only JSONL 파일입니다. 프롬프트, 제안된 호출(도구, 종류, 가려진 미리보기, 경로), 결과가 호스트의 `tool_use_id`로 이어져 기록됩니다. 결과가 끝내 오지 않은 호출은 (호스트가 중단됐거나 새 프롬프트가 먼저 왔거나) `unknown`이고, `unknown`은 절대 증거로 쓰지 않습니다. 여기서 guard는 눈앞의 호출에 대해 이런 것을 뽑아냅니다. 같은 행동이 이 턴에 몇 번 있었는지, 지난번 결과가 무엇이었는지, 마지막 통과 이후 무엇이 바뀌었는지, 그래서 그 통과가 아직 *valid*인지 *stale*인지 *unknown*인지.

**분류는 결정론적이고 오프라인입니다.** 모델이 관여하기 전에 명령을 세그먼트로 나누고(heredoc 본문 제거, 따옴표 존중) 첫 단어로 분류합니다. test·build·lint runner면 `check`이고(runner regex와 runner 출력 파서 26종은 [jev-belay](https://github.com/valentynkit/jev-belay)에서 가져왔습니다), `sed -i`, 리다이렉트, `rm`, 패키지 설치, 트리를 건드리는 git 작업은 쓰기이며, 스크립트와 알 수 없는 명령은 일부러 변경으로 셉니다. Claude Code는 명령의 exit code를 알려주지 않으므로 검사의 통과 여부는 runner가 출력에 남기는 요약 줄에서 읽습니다.

**판단 대상 호출마다 Jev 요청 한 번.** Jev는 TypeSafe의 *System One* 모델입니다. state와 타입이 있는 질문을 받아 산문이 아니라 확률을 수백 밀리초 안에 돌려줍니다. jev-save가 보내는 것은 호출의 투영(명령은 잘라내고 가린 것, 편집은 경로와 변경 크기, 파일 본문이나 patch는 절대 아님), 사용자의 요청, 최근 지시 몇 개, 최근 호출과 결과를 설명하는 열 줄, 그리고 ledger의 집계입니다. 한 요청에 다음을 함께 묻습니다.

| id | 타입 | 질문 |
| --- | --- | --- |
| `in_scope` | 예/아니오 | 요청을 완수하는 데 필요한 작업인가? 관련 코드 읽기나 변경에 대한 테스트 추가 같은 보조 작업을 포함해서 |
| `necessary` | 예/아니오 | 이미 한 일과 알게 된 것을 볼 때 이 호출이 지금 요청을 진전시키는가? |
| `redundant` | 예/아니오 | 아직 유효한 결과를 새 정보 기대 없이 반복하는가? |
| `scope_expansion` | 예/아니오 | 새 추상화, 무관한 리팩터링, migration, 추가 기능, 사용자가 제외한 영역의 편집을 들여오는가? |
| `kind` | 선택 | progress · verification · exploration · repetition · expansion |
| `risk`, `approval`, `user_requested` | jev-guard의 질문 | 얼마나 해로울 수 있는가, 신중한 엔지니어라면 사람의 확인을 원할까, 사용자가 정확히 이것을 부탁했는가? |

**정책은 코드이고 순수 함수입니다.** 보안이 먼저입니다. risk 2.5 이상은 deny, 1.5 이상은 ask이며, 사용자의 명시적 요청은 ask를 풀 수 있어도 deny는 풀지 못합니다. 그다음 권고는 우선순위에 따라 최대 하나입니다. *scope*(expansion 0.85 이상, 또는 in_scope 0.15 이하이면서 expansion 0.5 이상. 두 신호가 일치해야 하고 비교할 요청이 있어야 함), *redundant*(0.85 이상이고 ledger가 마지막 통과를 아직 valid로 볼 때만), *necessary*(0.20 이하). 잔소리를 막는 억제 규칙이 있습니다. 같은 행동에 턴당 한 번, 턴당 세 번, 연속 두 호출에는 내지 않음. 모델이 권고를 읽고도 같은 일을 하면 jev-save는 침묵합니다. 정당한 고집일 수 있으니까요.

**보안 대상은 효율 분류와 별도로 정합니다.** security가 `on` 또는 `log`이면 모든 셸·MCP 호출이 판단 후보입니다. 이름이나 명령이 읽기처럼 보여도 동일합니다. 셸 분류는 추정 규칙이며 보안 경계가 아닙니다. 전용 읽기·검색 도구는 같은 턴에서 반복되거나 턴의 호출이 이미 12번을 넘었을 때 판단합니다. security가 `off`이면 셸·MCP에도 선택적인 효율 판단 규칙을 적용합니다. 명시적인 `JEV_SAVE_SKIP_TOOLS` 제외와 세션 상한은 계속 적용됩니다.

**비용은 제한됩니다.** 기본 상한은 세션당 provider 호출 시도 200번입니다. provider 실행 전에 ledger 잠금 안에서 횟수를 예약하며 실패도 차감합니다. 동시 hook도 같은 상한을 공유합니다. cache 적중은 차감하지 않고, provider 호출 내부의 HTTP 재시도는 같은 예약에 포함됩니다. cache 키에는 state 전체와 질문 묶음이 포함됩니다. 오류는 기본적으로 호출을 통과시키고 기록합니다. `JEV_SAVE_FAIL_CLOSED`의 오류 차단은 `advise` 모드이면서 security가 `on`인 보안 대상 호출에만 적용됩니다. shadow 모드와 security `log`/`off`에서는 오류로 차단하지 않습니다.

**증거는 보수적으로 유지합니다.** 같은 행동이 나중에 실패하면 이전 통과는 유효하지 않고, 결과가 불명확하거나 실행 중이면 불확실합니다. 모든 ledger 추가 기록과 compaction은 같은 잠금을 사용합니다. compaction 후에도 최초 요청, 전체 호출 시도 수, 호출·턴 번호는 보존됩니다. 잠금 시간 초과나 쓰기 실패 시 `.jsonl.uncertain` 표시를 남기고 해당 세션의 validity를 unknown으로 두며 새 provider 호출을 중단합니다. 도구 실행은 계속 허용합니다. 오래된 잠금도 임의로 빼앗지 않습니다. 프로세스 중단으로 잠금만 남았다면 새 세션을 시작하세요. 남은 세션 파일을 수동 정리할 때는 먼저 호스트를 종료해야 합니다.

**shadow가 먼저지만, 길 필요는 없습니다.** 배포 기본값은 모든 판단을 `~/.jev-save/decisions.jsonl`에 기록하고 에이전트에게는 아무것도 보내지 않습니다. advise 모드도 똑같이 기록하므로 일찍 켜도 잃는 것이 적습니다. 잘못된 효율 권고는 에이전트가 무시할 수 있는 한 줄이고, 로그에는 무엇이 발동했고 에이전트가 방향을 바꿨는지가 남습니다. shadow 기간이 주는 것은 권고 없는 기준선인데, 그것은 나중에 fixture A/B로 얻을 수 있습니다. 켜기 전에 정할 것은 보안 게이트 하나입니다. 그 `ask`는 실제 승인 프롬프트가 되므로(실측에서 `sed -i` 편집이 risk 1.7), 호스트가 이미 권한 분류기를 돌린다면 `jev-save security log`로 두세요.

## 설치

Node 20.3 이상과 [console.typesafe.ai/keys](https://console.typesafe.ai/keys)에서 발급받은 TypeSafe 키가 필요합니다. 키는 `~/.jev-save/config.json`에 0600 권한으로 저장되고 `api.typesafe.ai`에만 전송되며 에이전트에게는 절대 주어지지 않습니다.

```bash
npm i -g jev-save                # 또는: git clone https://github.com/grapefruit0205/jev-save && cd jev-save
jev-save key "…"                 # 또는 export TYPESAFE_API_KEY
jev-save install claude          # ~/.claude/settings.json을 백업하고 hook 4개를 추가하며, 추가한 것을 정확히 기록
jev-save install codex           # ~/.codex/hooks.json에 동일. 그 뒤 Codex 안에서 /hooks로 신뢰 처리
jev-save doctor                  # node, 키, Jev 왕복 1회, hook 등록, 상태 디렉터리 점검
```

플러그인으로 설치하려면 Claude Code에서 `/plugin marketplace add grapefruit0205/jev-save` 뒤 `/plugin install jev-save@jev-save`, Codex에서 `codex plugin marketplace add grapefruit0205/jev-save`입니다.

```bash
jev-save mode advise                          # 권고를 켬 (기본: shadow, 로그만). 판단은 어느 모드에서나 전부 기록됨
jev-save security log                         # jev-guard의 deny/ask는 기록만 (Claude Code의 권한 계층이 그대로 담당)
jev-save check --task "로그인 고쳐" Bash '{"command":"pytest -q"}'   # 호출 하나를 판단하고 신호를 출력
jev-save stats --days 7                       # 결정 로그 요약
jev-save uninstall claude                     # install이 기록한 항목만 제거. 백업은 남음
JEV_SAVE_PROVIDER=mock jev-save check …       # 오프라인 mock provider, 키 불필요
```

Claude Code는 hook을 바로 읽습니다. 실행 중인 세션에도 적용됩니다. Codex는 `/hooks`에서 먼저 신뢰 처리해야 합니다.

| 변수 | 기본값 | 효과 |
| --- | --- | --- |
| `JEV_SAVE_MODE` | `shadow` (또는 `config.json`) | `advise`면 권고를 에이전트에게 보냄 |
| `JEV_SAVE_SECURITY` | `on` (또는 `config.json`) | `log`면 보안 질문은 묻되 판정을 기록만 하고 deny/ask를 보내지 않음. 호스트가 이미 권한 분류기를 돌리는 경우용. `off`면 묻지 않음. `jev-save security on\|log\|off` |
| `JEV_SAVE_ASK_SCORE` `JEV_SAVE_DENY_SCORE` | `1.5` `2.5` | jev-guard의 risk 임계값. bash 우선 작업이라면 `JEV_SAVE_ASK_SCORE=2`가 나을 수 있음 (실측에서 `sed -i` 편집이 1.7) |
| `JEV_SAVE_MAX_CALLS` | `200` | 실패를 포함한 세션당 provider 호출 시도 수. compaction 후에도 보존 |
| `JEV_SAVE_LONG_TURN` | `12` | 이 수를 넘는 턴에서는 읽기도 판단 |
| `JEV_SAVE_TIMEOUT_MS` | `5000` | Jev 호출당 예산, 재시도 포함 |
| `JEV_SAVE_NECESSARY_P` `JEV_SAVE_EXPANSION_P` `JEV_SAVE_INSCOPE_P` `JEV_SAVE_REDUNDANT_P` | `0.20` `0.85` `0.15` `0.85` | 권고 임계값. 실험용 초기값 |
| `JEV_SAVE_MAX_ADVISORIES` `JEV_SAVE_COOLDOWN_CALLS` | `3` `2` | 턴당 권고 상한, 권고 사이의 호출 수 |
| `JEV_SAVE_CHECK` | | 프로젝트 고유 검사 명령을 나타내는 regex |
| `JEV_SAVE_JUDGE_KINDS` | `edit,write-bash,other,check,vcs,external-write` | 효율 판단을 항상 수행할 kind. 보안 대상은 줄이지 않음. 셸·MCP에도 선택적인 효율 규칙을 적용하려면 security를 `off`로 설정 |
| `JEV_SAVE_SKIP_TOOLS` | | 판단하지 않을 도구 이름 |
| `JEV_SAVE_FAIL_CLOSED` | 없음 | `advise` 모드이며 security가 `on`인 보안 대상 호출에만 provider/hook 오류 시 deny. `0`, `false`, `off`, `no`는 비활성화 |
| `JEV_MODEL` | `jev-latest` | API가 별칭만 받음 (2026-09-21에 `jev-1.13.0` 직접 지정이 거절됨). 실제로 응답한 버전을 판단마다 기록하므로 로그 비교는 그것으로 함 |
| `JEV_SAVE_SESSIONS` `JEV_SAVE_LOG` `JEV_SAVE_CONFIG` | `~/.jev-save/…` | 상태 위치 |

## 무엇이 밖으로 나가는가

Jev 요청뿐입니다. 도구 이름과 입력의 투영(셸 명령은 2,000자로 자르고 자격증명 모양을 가린 것, 편집은 파일 경로와 변경 크기와 앞 300자, patch는 파일 목록과 앞부분), 홈 디렉터리를 `~`로 바꾼 `cwd`, 최근 프롬프트 세 개(최대 1,500자), 최근 호출과 결과를 설명하는 한 줄짜리 열 개. 파일 본문과 도구 출력은 없습니다. 로컬 로그에 쓰이는 모든 것에도 같은 가림 규칙이 적용됩니다.

## 한계

- **Jev는 신뢰할 수 없는 텍스트를 읽는 확률 모델입니다.** 답에는 측정된 오류율이 있을 뿐 보장은 없습니다. jev-save는 보안 샌드박스가 아닙니다. 호스트의 권한 통제는 그대로 두세요. 보안 질문은 jev-guard의 것이고 그 보정 상태를 물려받습니다.
- **"아직 유효함"은 상한입니다.** ledger는 hook이 본 것만 압니다. 사용자나 다른 프로세스의 편집, 의존성과 환경 변화, 외부 서비스는 보이지 않습니다. 그래서 redundant 판단은 권고에 그치고, 강제는 이 버전에 없습니다.
- **임계값은 초기값입니다.** 라벨링된 corpus가 아니라 실제 호출 몇 개로 정했습니다. shadow를 돌리고 표본을 라벨링한 뒤 정하세요.
- **호스트마다 다릅니다.** Codex에는 `ask`가 없어 보안 ask는 "먼저 확인을 받으라"는 deny가 됩니다. Codex는 비정상 종료도 `PostToolUse`로 보내며, 셸 명령의 `tool_response` 형태는 미확인이라 runner 파서가 출력 텍스트로 통과 여부를 정합니다.
- **지연.** 초기 실측에서 판단되는 호출마다 Jev 왕복과 Node 기동으로 약 0.7초가 들었습니다. 전용 읽기·검색 도구는 선택적으로 판단하지만 security `on`/`log`에서는 상한 안의 모든 셸·MCP 호출이 대상입니다. 이전의 선택적 분류 기준 비용 측정은 현재 기본값에 그대로 적용할 수 없습니다.

## 측정

```bash
node tools/extract-corpus.mjs --days 30    # Claude Code transcript → corpus/turns.jsonl (가려진 투영, 로컬에만 남음)
node tools/baserate.mjs                    # 세션에 반복 검증과 재읽기가 얼마나 있는지
jev-save stats --days 7                    # 결정, 발동·억제된 권고, 지연, 보안 게이트
```

## 어디서 가져왔는가

| 부분 | 출처 |
| --- | --- |
| Jev 클라이언트, Claude Code / Codex hook 배관, 보안 질문, 키 저장, 다른 호스트용 어댑터(`hook --legacy`) | [jev-guard](https://github.com/leepokai/jev-guard) (fork) |
| test runner 감지, runner 출력 파서와 픽스처, 가림 규칙, shadow 뒤 측정하는 방법 | [jev-belay](https://github.com/valentynkit/jev-belay) (vendored) |
| 셸 쓰기/읽기/git 분류, 평가 방법(상수 추측 baseline, 유해 권고율) | [claude-jev](https://github.com/0x7067/claude-jev) |
| runner 파서 뒤의 질문 문구 | [pi-warden](https://github.com/DevMortimer/pi-warden), jev-belay 경유 |

설계 노트, 단계 계획, 확인된 호스트 hook 계약, base rate 측정: [`docs/design.md`](docs/design.md), [`docs/baserate-2026-09-21.md`](docs/baserate-2026-09-21.md).

## 개발

```bash
npm test          # node:test, 오프라인 (mock provider + jev-guard의 가짜 fetch). 키 불필요
```

구조: `src/core/` (evidence · ledger · context · questions · policy · cache · log · guard) · `src/providers/` (`DecisionProvider` 경계: jev, mock) · `src/adapters/` (claude, codex) · `src/save-hook.js` (hook 진입점) · `src/install/` (hosts, registry, doctor) · `tools/` (corpus, base rate) · jev-guard의 파일은 다른 호스트를 위해 그 자리에 둡니다.

## 라이선스

MIT. `LICENSE`에 upstream 고지가 있습니다.
