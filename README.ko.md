<div align="center">
  <img src="assets/icon.svg" width="96" alt="jev-save">
  <h1>jev-save</h1>
  <p><strong>코딩 에이전트를 위한 runtime 효율 guard. <a href="https://typesafe.ai/">Jev</a>로 판단합니다.</strong></p>
  <p>Claude Code나 Codex가 tool call을 실행하기 직전에, 세션 원장이 그 호출이 이미 한 일의 반복인지 말하고, Jev에게는 지금 필요한지, 사용자가 부탁한 범위를 넓히는지, 반복이라면 에이전트가 이유를 댔는지 묻습니다.</p>
  <p><a href="README.md">English</a> · <a href="https://github.com/leepokai/jev-guard">leepokai/jev-guard</a> 기반</p>
</div>

> **상태: 0.1.0, 측정 완료, 대화형 사용은 보류.** 이틀의 실사용, 세 프로젝트 네 번의 무인 실행, 저자의 30일치 transcript 재생 결과를 [무엇을 알아냈는가](#무엇을-알아냈는가)에 정리했습니다. 짧게: 동작하고, 틀린 말은 안 하지만, 강한 모델과 대화형으로 일하는 세션에서는 잡을 것이 없습니다. 자리는 약한 모델의 무인 실행입니다. 설치 전에 그 절을 읽어 주세요.

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

## 무엇을 알아냈는가

아래는 전부 2026-09-21/22에 잰 것입니다. 표와 원자료는 [docs/trial-2026-09-22.md](docs/trial-2026-09-22.md), 측정이 바꾼 설계 결정은 [docs/design.md](docs/design.md)와 [CHANGELOG.md](CHANGELOG.md)에 있습니다.

**무엇을 위한 것인가.** 낭비 세 종류입니다. 에이전트가 *헛도는 것*(통과한 검사를 다시 돌림, 실패한 명령을 고치지 않고 다시 돌림), *과구현*(요청 밖의 일), *과설계*(요청에 비해 과한 구조).

**무슨 일이 있었나, 순서대로.**

1. *대화형 하루, Opus, 저자가 화면을 보는 중.* 310건 판정. guard가 13번 말했고 11번 틀렸습니다(2건 미라벨). 틀린 원인은 하나였습니다. 잘못된 텍스트에 대고 잰 것 — 30턴 지난 첫 프롬프트, 붙여넣은 문서, 내용이 에이전트 메시지에 있던 승인("부탁할게"). 잡으려는 사건은 아예 없었습니다. 저자의 한 달 transcript에서 "아무것도 안 바뀌었는데 통과한 검사를 다시 돌린" 횟수는 16번, 5분어치였습니다.
2. *무인 실행, Terraform 드리프트 감사, 약한 모델(DeepSeek Flash)이 실행자.* 66턴 65호출. 에이전트가 `terraform plan`을 열 번 돌렸고 그중 여섯은 새 정보가 나올 수 없는 실행이었습니다. 당시의 guard는 침묵했습니다. 재실행마다 파이프가 달라서(`| tail`, `| grep`) 원장은 열 개의 다른 행동으로 봤고, 사실을 다 적어 줘도 Jev의 `redundant`는 0.07~0.18이었습니다. 이어진 수정은 전부 코드를 쓰기 전에 기록으로 검증했습니다. 행동의 정체는 명령이 *만드는 것*(파이프·echo·리다이렉트 제거); 반복 규칙은 원장만 봄; Jev는 원장이 모르는 것 하나 — 에이전트가 새 결과를 기대할 이유를 말했는가 — 만 판단(이유가 있으면 0.85~0.90, 없으면 0.19~0.24); 거부된 호출은 트랜스크립트로 닫아 증거를 망치지 않게; terraform과 Python `unittest` 출력은 `| tail`이 종료 코드를 가리므로 파싱. 재생 결과: 보낸 줄 2, 둘 다 맞음; 이유가 있어 거둔 줄 2, 둘 다 맞음; 나머지 침묵.
3. *무인 실행, Python 프로젝트에 심은 한 줄짜리 버그.* 11호출로 깔끔히 수정, 권고 0, 사건 0.
4. *무인 실행, 작은 Go 기능, 두 번.* 16호출과 19호출, 둘 다 최소로 규칙 안에서, 권고 0. 모든 편집에서 `in_scope`가 0.83 이상이라 scope 규칙은 정당한 기능 작업 근처에도 안 갑니다.
5. *요청 추적, 대화형 로그로 검증.* 이제 Jev가 프롬프트마다 그것이 *무엇인지*(task, approval, 붙여넣은 자료, question, steer)를 말하고 원장이 요청을 갱신합니다. 라벨 11건을 낸 세션 3개(프롬프트 129개, 실제 입력)로 재생하니 틀린 9건이 0이 되고 범위 안 대조군 26건 중 새로 틀린 것은 없었습니다. 비용은 프롬프트당 0.7초.
6. *과설계, base rate.* 30일 transcript에서 파일을 바꾼 턴 중 Edit/Write를 거친 건 18%뿐(나머지는 셸·스크립트 편집이라 어떤 크기 규칙에도 안 보임), 그 안에서 작은 요청에 큰 결과가 나온 경우는 전부 정당했습니다. 만들지 않았습니다.

**세 프로젝트 합산:** 무인 실행에서 판정 90건, 보낸 줄 2, 둘 다 실제 낭비, 틀린 줄 0, 판정당 0.6초, 깨진 세션 0.

**결론, 쉽게.**

| 당신이 | 설치? | 이유 |
| --- | --- | --- |
| 강한 모델과 대화형으로, 화면을 보며 일한다 | 아니오 | 저자의 30일 세션에서 이것이 잡는 사건은 일어나지 않았습니다. 침묵에 호출당 0.6초, 프롬프트당 0.7초를 내고, 루프는 당신이 더 빨리 끊습니다 |
| 무인 작업을 돌린다(`claude -p`, `codex exec`, 예약 작업), 특히 약한 모델로 | 예, `advise` + `security log` | 루프는 거기서 나고, 보는 사람이 없고, 요청이 고정된 텍스트 하나입니다. 66턴에서 두 번 말했고 둘 다 맞았습니다 |
| 내 에이전트가 실제로 뭘 낭비하는지 궁금하다 | 하루 `shadow`로 켜고 `jev-save stats`를 본다 | 권고가 침묵해도 원장과 판단 로그는 그 자체로 쓸모 있는 산출물입니다 |

안 됐던 것, 그래서 뺐거나 안 만든 것: Jev에게 묻는 `redundant` 질문(원장의 사실을 확인해 주지 않음), `necessary` 규칙(어디서도 맞은 적 없음), 대화 전체를 Jev에게 보내기(의도는 맞추고 사실은 틀림), 현재 턴 프롬프트를 요청으로 쓰기(축약어와 붙여넣기에 무너짐), 다른 명령으로 같은 정보를 묻는 반복을 잡는 `known_information` 질문(안 갈림), 과설계용 크기 신호(사건 없음, 편집의 82%가 안 보임).

## 어떻게 동작하는가

```
사용자 프롬프트 ──► UserPromptSubmit hook ──► Jev 1회: 이 메시지는 무엇인가 ──► ledger: 새 턴, 지금 시점의 요청
tool call      ──► PreToolUse hook ──────► 분류 ──► Jev에 물을 호출인가? ──► Jev 요청 한 번 ──► 정책 ──► allow / 권고 / ask / deny
tool 결과       ──► PostToolUse hook ─────► ledger: 결과(pass / fail / unknown), 소요 시간, 출력 크기
```

**ledger.** hook은 호출마다 별도 프로세스로 뜨므로, 세션의 기억은 `~/.jev-save/sessions/` 아래 세션당 하나인 append-only JSONL 파일입니다. 프롬프트, 제안된 호출(도구, 종류, 가려진 미리보기, 경로), 결과가 호스트의 `tool_use_id`로 이어져 기록됩니다. 결과가 끝내 오지 않은 호출은 (호스트가 중단됐거나 새 프롬프트가 먼저 왔거나) `unknown`이고, `unknown`은 절대 증거로 쓰지 않습니다. 여기서 guard는 눈앞의 호출에 대해 이런 것을 뽑아냅니다. 같은 행동이 이 턴에 몇 번 있었는지, 지난번 결과가 무엇이었고 얼마나 걸렸는지, 마지막 통과 이후 무엇이 바뀌었는지, 그래서 그 통과가 아직 *valid*인지 *stale*인지 *unknown*인지, 그리고 아무것도 바뀌지 않은 채 같은 실패가 몇 번 쌓였는지.

"같은 행동"은 정확한 명령 문자열이 아니라 *생산자*입니다. `terraform plan | tail -250`과 `terraform plan | grep "No changes"`는 같은 행동을 다른 파이프로 본 것입니다(파이프라인 소비자, 라벨용 echo, 출력 리다이렉트는 버리고 플래그, `cd`, 환경 변수 대입, heredoc 본문은 남깁니다). 답변 캐시는 여전히 정확한 입력을 키로 씁니다.

**무엇이 요청인가.** 대화에서 요청은 첫 프롬프트로 고정되지 않습니다. 프롬프트마다 Jev에게 메시지 자체에 대해 하나를 묻습니다. *task*인지, 방금 제안한 것에 대한 *approval*인지, 붙여넣은 *material*인지, *question*인지, 진행 중인 일에 대한 *steer*인지, 그리고 직전 에이전트 메시지를 가리키는지. task(또는 붙여넣기)는 요청을 바꾸고 가리킨다면 그 에이전트 메시지를 함께 붙이며, 제안 뒤의 "부탁할게"는 그 제안을 요청으로 만들고, steer는 덧붙이고, question은 아무것도 바꾸지 않습니다. 대화형 로그의 틀린 scope 권고는 전부 잘못된 텍스트에 대고 잰 것이었습니다(33턴 전 첫 프롬프트, 붙여넣은 문서, 내용이 에이전트 메시지에 있던 승인). 이 추적으로 다시 재니 틀린 9건이 0이 됐고 범위 안 대조군 26건 중 새로 틀린 것은 없었습니다(docs/trial-2026-09-22.md). 비용은 프롬프트당 Jev 1회, UserPromptSubmit 훅 안에서 약 0.7초. Jev가 안 되면 프롬프트는 분류 없이 기록되고 요청은 그대로입니다.

Claude Code에서는 호스트 자신의 트랜스크립트 끝부분도 읽습니다. hook이 절대 전해주지 않는 두 가지 때문입니다. PostToolUse가 뜨지 않은 호출의 결과(`dontAsk` 모드의 권한 거부는 항목을 *실행 안 됨*으로 닫아서 실행으로도 변경으로도 세지 않음), 그리고 호출 직전 에이전트가 말한 것, 즉 밝힌 이유입니다.

**분류는 결정론적이고 오프라인입니다.** 모델이 관여하기 전에 명령을 세그먼트로 나누고(heredoc 본문 제거, 따옴표 존중) 첫 단어로 분류합니다. test·build·lint runner면 `check`이고(runner regex와 runner 출력 파서 26종은 [jev-belay](https://github.com/valentynkit/jev-belay)에서 가져왔습니다), `sed -i`, 리다이렉트, `rm`, 패키지 설치, 트리를 건드리는 git 작업은 쓰기이며, 스크립트와 알 수 없는 명령은 일부러 변경으로 셉니다. Claude Code는 명령의 exit code를 알려주지 않으므로 검사의 통과 여부는 runner가 출력에 남기는 요약 줄에서 읽습니다.

**판단 대상 호출마다 Jev 요청 한 번.** Jev는 TypeSafe의 *System One* 모델입니다. state와 타입이 있는 질문을 받아 산문이 아니라 확률을 수백 밀리초 안에 돌려줍니다. jev-save가 보내는 것은 호출의 투영(명령은 잘라내고 가린 것, 편집은 경로와 변경 크기, 파일 본문이나 patch는 절대 아님), 사용자의 요청, 최근 지시 몇 개, 최근 호출과 결과를 설명하는 열 줄, 그리고 ledger의 집계입니다. 한 요청에 다음을 함께 묻습니다.

| id | 타입 | 질문 |
| --- | --- | --- |
| `in_scope` | 예/아니오 | 요청을 완수하는 데 필요한 작업인가? 관련 코드 읽기나 변경에 대한 테스트 추가 같은 보조 작업을 포함해서 |
| `necessary` | 예/아니오 | 이미 한 일과 알게 된 것을 볼 때 이 호출이 지금 요청을 진전시키는가? |
| `scope_expansion` | 예/아니오 | 새 추상화, 무관한 리팩터링, migration, 추가 기능, 사용자가 제외한 영역의 편집을 들여오는가? |
| `kind` | 선택 | progress · verification · exploration · repetition · expansion |
| `message_kind`, `refers_to_previous` | 선택, 예/아니오 | 호출이 아니라 프롬프트마다: task · approval · paste · question · steer, 그리고 직전 에이전트 메시지를 가리키는가 |
| `expects_new_information` | 예/아니오 | 이미 실행된 호출을 반복할 때만 묻는다. 에이전트의 직전 서술이 다른 결과를 기대할 구체적 이유를 말하는가? 앞 결과가 틀렸다는 의심, 바뀐 입력, 적용한 수정, 큰 출력의 다른 부분 |
| `risk`, `approval`, `user_requested` | jev-guard의 질문 | 얼마나 해로울 수 있는가, 신중한 엔지니어라면 사람의 확인을 원할까, 사용자가 정확히 이것을 부탁했는가? |

`redundant` 질문은 없어졌습니다. 원장의 사실(같은 생산자, 직전 실행 통과, 그 뒤 변경 없음)을 그대로 보여줘도 Jev는 무인 실행 시험의 plan 재실행에 0.07~0.18로 답했습니다. 그래서 반복인지는 원장이 정하고, Jev는 예외를 정합니다.

**정책은 코드이고 순수 함수입니다.** 보안이 먼저입니다. risk 2.5 이상은 deny, 1.5 이상은 ask이며, 사용자의 명시적 요청은 ask를 풀 수 있어도 deny는 풀지 못합니다. 그다음 권고는 우선순위에 따라 최대 하나입니다.

- *scope* — expansion 0.85 이상, 또는 in_scope 0.15 이하이면서 expansion 0.5 이상(두 신호가 일치해야 하고 비교할 요청이 있어야 함), 또는 in_scope 0.15 이하이면서 approval 0.9 이상. 마지막은 범위를 넓히는 행동이 아니라 금지된 행동입니다("commit 금지"에 대한 commit이 in_scope 0.04, approval 0.96, expansion 0.44).
- *repeat-failure* — 원장의 사실. 같은 행동이 연속 두 번 실패했고 그 사이 아무것도 바뀌지 않음. `#53 and #59 ran this and failed; nothing changed since. Fix the cause before running it again.`
- *redundant* — 원장의 사실. 이 행동의 직전 실행이 통과했고, 그 뒤 바뀐 게 없고, 다시 돌리는 데 비용이 듦(5초 이상 또는 출력 4 KB 이상). `#11 ran this (14 s) and passed; nothing changed since. If you need another part of its output, save it once instead of re-running.` `expects_new_information` 0.8 이상이면 거둡니다. "grep 결과가 비어서 이상하다, 전체를 보자"는 이유이고, "다음은 ALB 속성을 보자"는 이유가 아닙니다.
- *necessary* — 0.20 이하.

잔소리를 막는 억제 규칙이 있습니다. 같은 행동에 같은 종류의 권고는 5호출에 한 번, 20호출에 세 번, 연속 두 호출에는 내지 않음. 모델이 권고를 읽고도 같은 일을 하면 jev-save는 침묵합니다. 정당한 고집일 수 있으니까요.

**보안 대상은 효율 분류와 별도로 정합니다.** security가 `on` 또는 `log`이면 모든 셸·MCP 호출이 판단 후보입니다. 이름이나 명령이 읽기처럼 보여도 동일합니다. 셸 분류는 추정 규칙이며 보안 경계가 아닙니다. 전용 읽기·검색 도구는 같은 턴에서 반복되거나 턴의 호출이 이미 12번을 넘었을 때 판단합니다. security가 `off`이면 셸·MCP에도 선택적인 효율 판단 규칙을 적용합니다. 명시적인 `JEV_SAVE_SKIP_TOOLS` 제외와 세션 상한은 계속 적용됩니다.

**비용은 제한됩니다.** 기본 상한은 세션당 provider 호출 시도 200번입니다. provider 실행 전에 ledger 잠금 안에서 횟수를 예약하며 실패도 차감합니다. 동시 hook도 같은 상한을 공유합니다. cache 적중은 차감하지 않고, provider 호출 내부의 HTTP 재시도는 같은 예약에 포함됩니다. cache 키에는 state 전체와 질문 묶음이 포함됩니다. 오류는 기본적으로 호출을 통과시키고 기록합니다. `JEV_SAVE_FAIL_CLOSED`의 오류 차단은 `advise` 모드이면서 security가 `on`인 보안 대상 호출에만 적용됩니다. shadow 모드와 security `log`/`off`에서는 오류로 차단하지 않습니다.

**증거는 보수적으로 유지합니다.** 같은 행동이 나중에 실패하면 이전 통과는 유효하지 않고, 같은 행동의 결과가 불명확하거나 실행 중이면 불확실합니다. 끝나지 않은 변경은 변경으로 세고, 끝나지 않은 읽기는 아무것도 아닙니다. terraform 실행의 판정은 자체 요약 줄에서 얻습니다. `| tail`이 종료 코드를 가리기 때문입니다. 모든 ledger 추가 기록과 compaction은 같은 잠금을 사용합니다. compaction 후에도 최초 요청, 전체 호출 시도 수, 호출·턴 번호는 보존됩니다. 잠금 시간 초과나 쓰기 실패 시 `.jsonl.uncertain` 표시를 남기고 해당 세션의 validity를 unknown으로 두며 새 provider 호출을 중단합니다. 도구 실행은 계속 허용합니다. 오래된 잠금도 임의로 빼앗지 않습니다. 프로세스 중단으로 잠금만 남았다면 새 세션을 시작하세요. 남은 세션 파일을 수동 정리할 때는 먼저 호스트를 종료해야 합니다.

**shadow 또는 advise.** 배포 기본값은 모든 판단을 `~/.jev-save/decisions.jsonl`에 기록하고 에이전트에게는 아무것도 보내지 않습니다. `jev-save mode advise`가 권고를 보냅니다. 둘 다 같은 것을 기록하므로 어느 쪽이든 로그가 산출물입니다. 무인 실행에서 실측한 설정은 `advise` + `security log`입니다. 보안 게이트의 `ask`는 그대로 두면 실제 승인 프롬프트가 되고(실측에서 `sed -i` 편집이 risk 1.7, 사용자가 시킨 `git commit`마다 2.0), 호스트는 이미 자체 권한 계층을 돌립니다. [무엇을 알아냈는가](#무엇을-알아냈는가)의 숫자를 낸 러너 — 저장소 사본, 허용 목록을 건 `claude -p --permission-mode dontAsk`, `advise`의 guard — 는 [docs/trial-2026-09-22.md](docs/trial-2026-09-22.md)에 있습니다.

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
