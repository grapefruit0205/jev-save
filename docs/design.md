# jev-save 구현 보정 (2026-09-21)

아래 v0.3/v0.2 기록과 충돌하면 이 절과 README의 현재 동작 설명이 우선한다. 기존 모듈 구조는 유지한다.

- 효율 kind 분류를 보안 경계로 쓰지 않는다. security `on`/`log`에서는 모든 셸·MCP 호출과 보안 대상 편집을 판단한다. `JEV_SAVE_JUDGE_KINDS`는 효율 후보만 조절한다. 명시적인 도구 제외와 세션 상한은 적용한다.
- `FAIL_CLOSED` 오류 차단은 `advise` + security `on`의 보안 대상 호출에만 적용한다. shadow와 security `log`/`off`는 오류로 차단하지 않는다.
- append와 compaction 모두 같은 잠금을 반드시 획득한다. 500ms 안에 획득하지 못하거나 쓰기에 실패하면 기록을 포기하고 세션에 영구적인 coverage gap 표시를 남긴다. validity는 unknown이며 새 provider 호출도 하지 않는다. 오래된 잠금을 임의로 회수하지 않는다. 프로세스 중단 후 고아 잠금이 남으면 새 세션을 사용한다.
- provider 실행 전에 잠금 안에서 호출 횟수를 예약한다. 실패도 차감하며 cache 적중은 제외한다. provider 내부 HTTP 재시도는 같은 예약을 사용한다. compaction snapshot은 최초 요청, 누적 시도 수, 턴·호출 번호를 보존하고 남기는 이벤트의 append 순서를 유지한다.
- 같은 행동의 후속 실패는 이전 pass를 stale로 만들고, 불명확하거나 미종료인 후속 실행은 unknown으로 만든다. redundant 권고는 validity가 valid이며 직전 완료 결과도 pass일 때만 가능하다.

# jev-save 설계 v0.3 (2026-09-21) — 방향 전환

v0.2 위에 1단계 base rate 결과([baserate-2026-09-21.md](baserate-2026-09-21.md))를 반영한 변경만 적는다. 아래 v0.2 본문은 그대로 두고, 충돌하는 곳은 이 절이 우선한다.

## 무엇이 바뀌는가

- **첫 MVP의 목표는 necessary와 scope 권고다.** 저자 corpus에서 "유효한 검증의 반복"은 한 달에 16건, 회피 가능 시간 5분 남짓이었다. 반면 tool call은 11,557건이고 시간은 셸 스크립트·읽기·외부 호출에 쓰였다. 그래서 RETRY 강제 대신 "이 호출이 지금 필요한가", "요청을 넓히는가"를 판단해 짧은 권고를 additionalContext로 돌려주는 것이 MVP다.
- **redundant는 신호로만 남는다.** ledger가 계산한 validity와 Jev의 redundant 답을 함께 기록하고, validity가 valid일 때만 권고 문구에 포함한다. 강제(enforce)는 MVP 범위 밖이며 §8의 조건은 그대로 남는다. git 지문(fingerprint.js)은 강제에만 필요하므로 뒤로 미룬다.
- **모드는 shadow와 advise 둘이다.** 효율 판단은 어느 모드에서도 실행을 막지 않는다. jev-guard에서 물려받은 보안 판단(risk, approval, user_requested, from_untrusted)은 JEV_SAVE_SECURITY=1일 때 같은 호출에 포함되고, 그 deny와 ask는 advise 모드에서 기존 jev-guard대로 동작한다.
- **Click과의 결합은 없다.** evidence.js의 click-gate 특례를 제거한다. jev-save는 독립 플러그인이다.

## 언제 Jev를 부르는가 (호출 수 제어)

모든 tool call이 아니라 후보에서만 부른다.

| kind | 호출 조건 |
| --- | --- |
| edit, write-bash, other, check, vcs, external-write | 항상 (보안 질문도 여기서만). vcs(commit·push)와 external-write(MCP의 create·send·delete)는 트리를 바꾸지 않지만 부작용이 있어 보안 질문이 필요하다 |
| read, search, external | 같은 턴에서 같은 digest가 이미 있었거나 (반복), 이 턴의 호출 수가 JEV_SAVE_LONG_TURN(기본 12)을 넘었을 때. 보안 질문은 묻지 않는다 |

실측(2026-09-21, jev-1.13.0): 우리 context를 본 approval 질문은 요청 밖 편집에 0.82~0.95를 준다. 위험도 1.0인 편집에 승인 프롬프트를 띄우면 "효율 판단은 막지 않는다"에 어긋나므로, approval만으로는 risk ≥ askScore(1.5)일 때만 ASK가 되고 그 아래에서는 scope 권고가 말한다(policy.js, `security:approval-only`로 기록).

세션당 상한 JEV_SAVE_MAX_CALLS(기본 200) 초과 시 판단 없이 통과하고 로그에 남긴다.

## 권고 문구와 억제

권고는 두 문장 이내, 사실(몇 번째 호출이 무엇을 했는지)을 앞세운다.

- necessary ≤ 0.20: "jev-save: this call looks unlikely to move the task forward (p=0.12). The last 9 calls were reads and searches with no edit; if you already know what to change, make the change."
- scope_expansion ≥ 0.85 또는 in_scope ≤ 0.15: "jev-save: this looks outside the request «로그인 버그만 고쳐…» (p=0.91). Keep to the request, or ask the user before widening it."
- redundant ≥ 0.85 이고 validity = valid: "jev-save: #12 ran this and passed; nothing observed changed since. Skip it unless you expect new information."

억제: 같은 digest에 턴당 한 번, 턴당 권고 3회, 연속 두 호출에 권고하지 않음. 모델이 권고를 무시하고 같은 행동을 다시 내면 침묵한다.

## 첫 실사용 로그에서 고친 것 (2026-09-21, 판단 7건)

- **합성 프롬프트.** 데스크톱 앱은 터미널 실행 결과를 `<bash-input>…</bash-input><bash-stdout>…` 형태의 사용자 메시지로 보내고, 슬래시 명령 echo·주입 문맥·중단 알림도 프롬프트로 온다. 이것이 original_request가 되면 이후 모든 편집이 "요청 밖"으로 판정된다(실측: stats.js 편집에 in_scope 0.15). guard.recordPrompt가 이런 프롬프트를 `synthetic`으로 표시하고, view는 턴 경계로만 쓰며 original_request와 recent_instructions에서 제외한다.
- **scope 발동 조건.** in_scope ≤ 0.15인데 scope_expansion 0.18인 경우가 나왔다. 두 신호가 어긋나면 "필요 없음"이지 "범위 확장"이 아니다. scope는 expansion ≥ 0.85, 또는 in_scope ≤ 0.15이면서 expansion ≥ 0.5일 때만 발동하고, original_request가 없는 세션(설치 전에 시작된 세션)에서는 판단하지 않는다.
- **보안 게이트의 ASK.** `sed -i` 편집이 risk 1.72, 임시 디렉터리에 쓰는 복합 명령이 1.5로 ASK였다. shadow에서는 로그뿐이지만 advise에서는 승인 프롬프트가 된다. bash 우선 작업 방식에서는 jev-guard의 risk 척도가 편집을 "되돌리기 어려움"으로 읽는 경향이 있다. 호스트가 이미 권한을 관리한다면 `JEV_SAVE_ASK_SCORE=2` 또는 `JEV_SAVE_SECURITY=0`이 선택지다. shadow 로그의 ASK 비율을 보고 advise 전에 정한다.

## 평가 (v0.2 §8의 조정)

권고에는 자동 정답이 없다. shadow 로그를 표본 추출해 사람이 "필요했음 / 불필요했음 / 판단 불가"와 "범위 안 / 보조 작업 / 확장"으로 라벨링하고, 상수 추측 대비 정밀도와 유해 권고율(필요한 호출에 낸 권고)을 잰다. 보조 지표로 "권고 뒤 다음 행동이 바뀌었는가"를 기록하되 정답으로 쓰지 않는다. A/B는 fixture에서 tool call 수, 턴 수, 완료율, 시간, 비용을 짝지어 잰다.

## 순서 (v0.2 §9의 조정)

| 단계 | 산출물 |
| --- | --- |
| 2 core | types, ledger(append-only, 수명주기, view, validity 신호), context, questions, policy, cache, log, providers(mock·jev), guard. 전부 오프라인 테스트 |
| 3 wiring | adapters(claude·codex), hook, hooks.json, install(백업·registry·uninstall), doctor, check 명령. 실제 키로 check 1회 |
| 4 shadow | 실사용 로그, stats, watch, 라벨링 표본 |
| 5 advise | 임계값 확정 후 advise 모드, fixture A/B |

---

# jev-save 설계 v0.2 (2026-09-21)

v0.1에 대한 외부 검토를 반영했다. 바뀐 곳은 §3 증거 상태 모델, §4 실행 수명주기와 저장, §6 모드 표, §8 평가, §9 순서다.
검토가 제기한 호스트 계약 사실은 Claude Code와 Codex 공식 문서로 다시 확인했다 (§10).

## 0. 한 줄 정의

Claude Code와 Codex의 tool call을 실행 직전에 가로채 Jev로 "필요한가, 중복인가, 범위 안인가"를 판단하고
ALLOW / RETRY / ASK / DENY를 돌려주는 runtime guard. leepokai/jev-guard를 fork하고 valentynkit/jev-belay의 증거 코드를 가져온다.
코드 생성 없음, 의존성 0, Node 20 이상, JS ESM.

첫 MVP의 범위는 **동일 검사 반복의 후보 탐지와 순절감 측정**이다. 범위 확장 판단과 Stop 판단은 advise와 shadow까지만 간다.

## 1. 출처와 저작권

| 출처 | 라이선스 | 가져오는 것 |
| --- | --- | --- |
| leepokai/jev-guard 0.3.1 | MIT | 저장소 골격 전체 (fork), Jev 클라이언트, Claude·Codex 어댑터, 보안 질문, install·key |
| valentynkit/jev-belay | MIT | runner regex, 출력 요약 파서, Stop 질문과 판단, 로그·통계·측정 도구, runner 출력 픽스처 26종 |
| 0x7067/claude-jev | MIT | Bash 쓰기 명령 regex (observed.py의 BASH_WRITE), 평가 방법 (상수 추측 baseline, 유해 판정 지표) |
| DevMortimer/pi-warden | MIT (belay 경유) | Stop 질문 문구 |
| vinilana/jev-eval-agent | 참고만 | 지표 이름 |

npm 이름 `jev-save`는 2026-09-21 기준 미등록.

## 2. 저장소 골격

```
jev-save/
├─ package.json              name jev-save · bin → src/cli.js · ESM · node>=20 · dependencies 없음
├─ LICENSE                   MIT + jev-guard / jev-belay / claude-jev / pi-warden 고지
├─ docs/design.md
├─ hooks/hooks.json          Claude: UserPromptSubmit · PreToolUse · PostToolUse · PostToolUseFailure · Stop
├─ hooks/codex.json          Codex: UserPromptSubmit · PreToolUse · PostToolUse · Stop
├─ .claude-plugin/  .codex-plugin/
├─ src/
│  ├─ cli.js
│  ├─ jev.js                 Jev 클라이언트 (jev-guard 그대로, 기본값만 변경)
│  ├─ hook.js                stdin JSON → 어댑터 → guard / stop → stdout JSON
│  ├─ adapters/claude.js  codex.js
│  ├─ core/
│  │  ├─ types.js            Action · Event · EvidenceState · DecisionResult
│  │  ├─ evidence.js         행동 분류 · runner regex · 출력 파서 · Bash 쓰기 regex
│  │  ├─ fingerprint.js      git 기반 작업 트리 지문
│  │  ├─ ledger.js           append-only 이벤트 로그와 view 재구성
│  │  ├─ validity.js         증거 상태 valid / stale / unknown 판정 (순수 함수)
│  │  ├─ context.js          view → Jev state (도구별 입력 투영 포함)
│  │  ├─ questions.js        보안 질문 + 효율 질문, bundle version
│  │  ├─ policy.js           answers + validity → 결정 (순수 함수)
│  │  ├─ cache.js            답변 cache
│  │  ├─ guard.js            PreToolUse 오케스트레이션 · 모드 · 상한
│  │  ├─ stop.js             Stop 판단
│  │  └─ log.js              decisions.jsonl · redact
│  ├─ providers/provider.js  jev.js  mock.js
│  └─ install/claude.js  codex.js  doctor.js  registry.js
├─ tools/fake-jev.mjs  extract-corpus.mjs  baserate.mjs  label.mjs  measure.mjs  ab/
└─ test/runners/  fixtures/  *.test.mjs
```

jev-guard의 acp.js, opencode.js, skills.js, extensions/ 는 남기되 hooks, README, 테스트에서 뺀다.

## 3. 증거 상태 모델

"편집 기록이 없다"와 "변경이 없음을 확인했다"를 구분한다. 어떤 검사의 직전 통과 결과에 대해 상태는 셋 중 하나다.

| 상태 | 조건 | 정책에서의 취급 |
| --- | --- | --- |
| valid | 아래 다섯 조건을 모두 만족 | redundant 판단의 전제가 됨 |
| stale | 관측된 변경이 하나라도 있음 | 재실행 필요. RETRY 금지 |
| unknown | 관측하지 못했을 가능성이 있음 | 재실행 허용. RETRY 금지 |

valid의 다섯 조건:

1. 같은 digest의 검사가 이 세션에서 `completed` + `pass`로 끝난 기록이 있다.
2. 그 통과 이후 hook이 관측한 변경이 없다. 변경으로 치는 것: Edit·Write·MultiEdit·NotebookEdit·apply_patch, `click-gate mutate` 같은 알려진 변경 명령, Bash 중 쓰기 regex에 걸리는 명령 (rm, mv, cp, mkdir, touch, patch, tee, install, `sed -i`, `>`, `>>`, heredoc), 그리고 read·search·check 어느 쪽으로도 분류되지 않은 Bash 명령 전부.
3. 작업 트리 지문이 통과 시점 종료 지문과 지금 같다 (§4 fingerprint). 사용자나 다른 프로세스의 tracked 파일 수정을 여기서 잡는다.
4. 그 사이 실행 상태가 `unknown`인 항목이 없다.
5. cwd가 같다.

관측 범위 밖은 unknown으로 남긴다. untracked·ignored 파일, 저장소 밖 경로, 의존성, 환경 변수, 외부 서비스, git이 아닌 디렉터리. 즉 valid라도 환경 변화까지 배제하지는 못하므로 RETRY는 끝까지 추정이며, enforce는 §8의 유해율 조건을 통과한 뒤에만 켠다.

Stop 판단도 같은 규칙을 쓴다. 마지막 변경 이후 통과한 검사가 test 또는 build 종류여야 "검증됨"으로 본다. lint만 통과한 경우는 검증되지 않은 것으로 둔다. 검사 종류는 evidence.js가 runner 이름으로 분류한다.

## 4. 실행 수명주기와 저장

세 축을 분리한다.

| 축 | 값 |
| --- | --- |
| 정책 결정 | ALLOW · RETRY · ASK · DENY · SKIP (판단 안 함) |
| 실행 상태 | proposed · blocked · running · completed · failed · unknown |
| 검사 결과 | pass · fail · unknown |

- PreToolUse: 항목 생성. 정책이 RETRY·DENY이고 모드가 enforce면 실행 상태 `blocked`로 확정한다. 그 외는 `running`. Claude Code는 hook이 막은 호출에 PostToolUse도 PostToolUseFailure도 보내지 않으므로 (문서 확인) `pending`을 남기지 않는다.
- PostToolUse: `completed`. Bash는 stdout과 stderr를 파서에 넣어 pass·fail·unknown. Codex는 비정상 종료도 PostToolUse로 온다 (문서 확인).
- PostToolUseFailure (Claude): `failed`. 입력은 `error`, `is_interrupt`, `duration_ms`, `tool_use_id` (문서 확인).
- 재조정: 같은 tool_use_id의 종료 이벤트 없이 다음 UserPromptSubmit이 오거나 10분이 지나면 `unknown`. unknown은 성공 증거로 쓰지 않는다.

식별자: 실행별 기본 키는 `tool_use_id` (Claude·Codex 모두 제공). digest는 "같은 행동인가"의 비교에만 쓴다. 병렬 실행은 tool_use_id로 구분한다.

저장: 세션당 append-only JSONL 한 파일 `~/.jev-save/sessions/<sha1(session_id)>.jsonl`. 모든 hook 프로세스는 한 줄을 append만 하고 (O_APPEND, 한 줄 4KB 이하), view는 파일을 재생해 만든다. 읽고-고치고-쓰기가 없으므로 동시 갱신 유실이 없다. 크기가 2MB를 넘으면 compaction하며, 이때만 `<file>.lock` 디렉터리로 배타 잠금을 잡고 원자적 교체를 한다. compaction은 digest별 마지막 통과 요약, 현재 턴의 항목, 미종료 항목을 보존한다.

이벤트 레코드:

```json
{"v":1,"at":0,"ev":"pre","turn":3,"tool_use_id":"toolu_01…","tool":"Bash","kind":"check","digest":"c1","preview":"pytest tests/test_auth.py -q","paths":[],"decision":"ALLOW","mode":"shadow","exec":"running","fp_start":"9f3…"}
{"v":1,"at":0,"ev":"post","turn":3,"tool_use_id":"toolu_01…","exec":"completed","result":"pass","duration_ms":4200,"fp_end":"9f3…"}
{"v":1,"at":0,"ev":"prompt","turn":4,"text":"…","digest":"…","kind":"user"}
```

fingerprint.js: `git status --porcelain=v1 -z`와 `git diff HEAD` 내용의 sha256 (약 30~50ms). 검사 시작과 종료에 각각 기록해 검사 도중 편집을 구분한다. git이 아니면 값 없음 → unknown.

프롬프트 기록: UserPromptSubmit마다 turn 증가. 단 우리가 직접 낸 Stop 차단 사유와 같은 텍스트는 사용자 프롬프트로 기록하지 않는다. Codex는 Stop 차단 사유를 새 사용자 프롬프트로 만들기 때문이다 (문서 확인). 첫 실질 프롬프트는 `original_request`로 따로 보존한다.

## 5. 파일별 책임

| 파일 | 출처 | 책임 |
| --- | --- | --- |
| src/jev.js | jev-guard | timeout 5초, 재시도 2, 모델 jev-1.13.0 고정, TYPESAFE_API_KEY 우선, 설정 ~/.jev-save/config.json |
| core/evidence.js | belay + claude-jev | classifyAction → check·read·search·edit·write-bash·other. CHECK_COMMAND, checkSummary, BASH_WRITE. runner 종류 test·build·lint |
| core/fingerprint.js | 새로 | git 지문. 실패·비git이면 null |
| core/ledger.js | 새로 (jev-guard session.js 대체) | append, replay, view(action) → {evidence 후보, edited_since, same_action_count_this_turn, recent(10), original_request, recent_instructions(3)} |
| core/validity.js | 새로 | view → valid·stale·unknown. 순수 함수, 픽스처로 테스트 |
| core/context.js | jev-guard 확장 | jev-guard의 state 형태 유지. 도구별 입력 투영: Bash는 command 2,000자, Edit는 file_path와 old·new 길이와 300자 미리보기, Write는 file_path와 크기와 앞 300자, apply_patch는 경로와 hunk 수와 300자. 원문·patch 전체·heredoc 본문은 보내지 않음 |
| core/questions.js | 새로 | 보안 4문 (jev-guard). from_untrusted는 PostToolUse 스캔이 켜진 경우에만 포함. 효율: in_scope, necessary, redundant, scope_expansion, kind. `BUNDLE_VERSION` 상수 |
| core/policy.js | 새로 | 입력은 answers + validity + view. 보안 먼저. redundant 조건은 validity가 valid일 때만 성립. 루프 차단. decisionMargin 계산 |
| core/cache.js | 새로 | key = model + BUNDLE_VERSION + 전송 state 전체의 canonical sha256. 답변만 저장, 정책은 매번 재평가. 상한 100. 적중률이 낮은 것은 의도 |
| core/guard.js | 새로 | skip 규칙, 세션 호출 상한, 모드, fail-open, 로그 |
| core/stop.js | belay | needsDoneCheck를 §3 규칙으로. final_message는 last_assistant_message |
| core/log.js | belay | decisions.jsonl, redact |
| providers/ | 새로 | provider.js 인터페이스, jev.js 래퍼, mock.js 픽스처 규칙 |
| adapters/claude.js | jev-guard 분리 | 문서 확인 필드만. PostToolUseFailure 처리 |
| adapters/codex.js | jev-guard | tool_name Bash·apply_patch. `ask`는 절대 내지 않음 (Codex는 hook 실패로 처리하고 실행을 계속함). ASK는 §6 표대로 |
| install/registry.js | 새로 | 우리가 쓴 hook 항목을 ~/.jev-save/installed.json에 그대로 저장. uninstall은 저장된 항목과 정확히 같은 것만 제거. 문자열 포함 여부로 판별하지 않음 |
| install/claude.js codex.js | jev-guard 확장 | 타임스탬프 백업 → 병합 → registry 기록 |
| install/doctor.js | 새로 | node, 키 존재(값 미출력), Jev 왕복 1회, hook 등록, 상태 디렉터리, 모드·모델, 마지막 결정 시각 |

## 6. 모드 표 (단일 기준)

| 상황 | shadow | advise | enforce |
| --- | --- | --- | --- |
| 효율 RETRY (Claude) | 로그만 | additionalContext | deny + reason |
| 효율 RETRY (Codex) | 로그만 | additionalContext | deny + reason |
| 효율 ASK (루프 차단 후) | 로그만 | additionalContext | Claude: ask + reason · Codex: deny + "confirm in your next message" |
| 보안 DENY | 로그만 | deny + reason | deny + reason |
| 보안 ASK | 로그만 | Claude: ask · Codex: deny + reason | 같음 |
| Stop 미검증 (Claude) | 로그만 | additionalContext | block + reason |
| Stop 미검증 (Codex) | 로그만 | 로그만 (Stop에 additionalContext 없음) | block + reason |
| 호출 상한 초과 | 로그 SKIP | 로그 SKIP | 로그 SKIP, 통과 |
| 키 없음 | 아무것도 안 함 | 같음 | 같음 (doctor가 경고) |
| provider 오류·timeout | 로그 error, 통과 | 같음 | 같음. JEV_SAVE_FAIL_CLOSED면 deny |

승인 예외: 사용자의 직접 요청은 jev-guard의 user_requested 질문으로 판정한다 (user_recent_messages에 근거, p ≥ 0.85). 적용 대상은 그 행동의 digest, 만료는 다음 사용자 프롬프트. 보안 DENY는 예외로 풀리지 않는다. 별도의 승인 수신 경로는 만들지 않는다.

기본 모드는 shadow. enforce는 효율 RETRY 중 redundant만 켜는 `enforce:redundant`와 전체 `enforce`로 나눈다. 첫 MVP는 `enforce:redundant`까지다.

## 7. 질문과 정책

효율 질문 문구는 보조 작업과 범위 확대를 구분한다.

- in_scope: 이 호출이 original_request와 recent_instructions를 완수하는 데 필요한 작업인가 (테스트 추가, 호출부 조사, 임시 디버그 출력 포함), 아니면 결과물의 범위를 늘리는가.
- necessary: 최근 행동과 결과를 볼 때 지금 이 호출이 진행에 필요한가.
- redundant: 같은 행동의 직전 결과가 pass이고 관측된 변경이 없을 때, 이 호출이 새 정보 없이 반복인가. (정책은 validity가 valid일 때만 이 답을 쓴다.)
- scope_expansion: 요청이 요구하지 않은 새 abstraction, 무관한 리팩터링, migration, 추가 기능을 들여오는가. 새 파일 자체는 근거가 아니다.
- kind (choice): progress · verification · exploration · repetition · expansion.

정책 순서: 보안 → redundant (valid일 때만) → scope (advise 전용, MVP에서는 enforce 안 함) → 루프 차단 (같은 digest RETRY 2회면 ASK) → ALLOW.

임계값 초기값 (실험용, shadow 결과로 다시 정한다): redundant 0.85, necessary 0.20, scope_expansion 0.85, in_scope 0.15, 루프 2회.

decisionMargin: 결정에 쓴 noul 신호들의 |p − 0.5| × 2 중 최소값. 보정된 정확도가 아니며 로그와 표시용이다.

## 8. 평가

세 가지를 따로 잰다.

1. **판단 정확도**: 실행 전 정보 기준으로 그 호출을 생략해도 됐는가. shadow 로그에서 후보를 모아 사람이 라벨링한다. 라벨 규칙은 corpus/RUBRIC.md에 둔다. 튜닝용과 평가용을 나눈다. 재실행이 통과했다는 사실만으로 RETRY가 맞았다고 세지 않는다. 사용자의 명시적 재확인 요청, flaky 조사, 환경 복구 확인은 "필요했음"으로 라벨링한다.
2. **작업 결과**: 실제 차단이 완료율, 결함 발견, 사용자 개입 횟수에 준 영향. A/B에서 tool call이 줄어도 완료율이 떨어지면 실패다.
3. **순절감**: 절약한 실행 시간과 토큰에서 Jev 호출 비용, hook 지연, 추가 대화, 복구 비용을 뺀 값.

유해 판정: RETRY된 호출과 같은 digest의 다음 실행이 fail이거나, 라벨이 "필요했음"인 경우. 실패는 회귀·flaky·인프라로 나눠 기록한다.

enforce:redundant 진입 조건 (초기값): 라벨링된 평가 표본에서 유해율 1% 이하, 상수 추측 대비 정밀도 향상 10포인트 이상, 세션 20개 이상.

완료 기준에 반드시 포함: 변경이 있으면, 직전 실행이 실패였으면, 병렬 실행이 있으면, 사용자가 명시적으로 재검증을 요청했으면 잘못 차단하지 않는다. 각각 픽스처 세션으로 테스트한다.

## 9. 순서

| 단계 | 산출물 | 완료 기준 |
| --- | --- | --- |
| 0 fork·이름 | 저장소, LICENSE, README 초안 | jev-guard와 jev-belay upstream 테스트 통과, fork 테스트 통과 |
| 1 base rate | evidence.js, tools/extract-corpus, tools/baserate | 본인 transcript 30일에서 편집 없는 동일 검사 재실행 수·비율, 검사당 평균 시간, 동일 읽기 반복. 여기서 계속할지 결정 |
| 2 ledger 정확성 | fingerprint, ledger, validity, PostToolUseFailure 등록, install·registry·doctor·uninstall | 픽스처 세션 (변경·실패·병렬·차단·unknown)에서 validity가 기대값. install 멱등·백업·정확한 제거 |
| 3 질문·정책·provider | context, questions, policy, cache, guard, providers, check 명령 | mock으로 반복 시나리오 RETRY, 변경 후 반복은 ALLOW, 안전한 편집 ALLOW. 실제 키로 check 1회 |
| 4 shadow | 모드, log, stats, watch, Stop | 실사용 로그 세션 20개 이상, 라벨링 표본, stats |
| 5 제한적 enforce | enforce:redundant, tools/ab | §8 진입 조건 통과 후 fixture A/B: tool call, 검사 재실행, 시간, 비용, 완료율, 유해 RETRY |

## 10. 확인된 호스트 계약 (2026-09-21, 공식 문서)

- Claude Code: PostToolUseFailure 입력 `tool_name, tool_input, tool_use_id, error, is_interrupt, duration_ms`. hook이 막은 호출에는 Post 계열 이벤트가 오지 않음. PostToolUse `updatedToolOutput` 있음. Stop 차단 시 UserPromptSubmit 발생 여부는 문서에 없음 (미확인).
- Codex: 이벤트 12개, PostToolUseFailure 없음, Bash 비정상 종료도 PostToolUse. PreToolUse `ask` 미지원이며 내면 hook 실패로 기록하고 실행 계속. tool_name은 `Bash`, `apply_patch`, `mcp__server__tool`. Stop 입력 `turn_id, stop_hook_active, last_assistant_message`. Stop 차단 사유는 새 사용자 프롬프트가 됨. additionalContext는 PreToolUse·PostToolUse·UserPromptSubmit 등에 있고 Stop에는 없음. `updatedToolOutput` 없음. hook 기본 timeout 600초, 설정 ~/.codex/hooks.json.
- 미확인: Codex PostToolUse의 Bash `tool_response` 내부 필드 (stdout·stderr 위치). 2단계에서 실제 이벤트를 로그로 받아 확인한다.
