# copilot-transcript-stats

**VS Code Copilot Chat 에이전트 트랜스크립트를 대화 통계·도구 사용 분석·실효 개발시간 추정으로 바꿔주는 의존성 없는 CLI.**

VS Code는 에이전트 채팅 세션마다 append-only JSONL 이벤트 로그를 남깁니다
(`…/User/workspaceStorage/<hash>/GitHub.copilot-chat/transcripts/<session>.jsonl`).
오후 한나절 작업이면 10MB, 약 1만 개 이벤트가 쌓입니다. 이 도구는 그 파일을 읽어
실제로 궁금한 것에 답합니다.

- **실제 요청**은 몇 번이었고, 기계 이벤트는 얼마나 섞여 있는가?
- 어떤 도구가 얼마나 돌았고, 몇 번 실패했고, 실제로 얼마나 걸렸는가?
- 벽시계 시간은 얼마였고, 그중 진짜 작업은 얼마인가?

## 왜 필요한가 (도구가 피해가는 세 가지 함정)

1. **도구 호출이 대화에 섞여 있다.** 트랜스크립트는 세 종류 레코드를 뒤섞습니다.

   | 종류 | 이벤트 | 의미 |
   | --- | --- | --- |
   | 대화 | `user.message`, `assistant.message` | 사람이 묻고 모델이 답함 |
   | 부기 | `assistant.turn_start/_end` | 에이전트 자체 루프 마커 |
   | 도구 왕복 | `tool.execution_start/_complete` | 도구 실행 |

   줄 수를 그냥 세면 기계 부기가 숫자를 지배합니다(예시 세션에서 **로그의 83.5%가
   사람/모델 메시지가 아님**). 도구는 이들을 분리하고 비율을 명시적으로 보여줍니다.

2. **벽시계 구간은 작업시간이 아니다.** 4일짜리 세션이 4일치 작업일 수 없습니다.
   점심, 주말, 켜둔 채 잊은 편집기가 전부 들어 있습니다.

3. **모든 "소요 시간"은 모델이므로, 모델을 공개한다.** 연속 이벤트 사이의 공백을
   합산하되 각 공백을 임계값(기본 5분)으로 자릅니다. 임계값은 **측정값이 아니라
   판단**이므로, 도구는 하나의 정답인 척하지 않고 민감도 곡선 전체를 출력합니다.

```
cap / gap  effective time        idle  active ratio
---------  --------------  ----------  ------------
      30s          5h 41m  2d 12h 45m          8.6%
       1m           7h 2m  2d 11h 24m         10.6%
     5m *         11h 15m   2d 7h 12m         16.9%
      30m         15h 26m    2d 3h 1m         23.2%
  * = 기본(headline) 계산에 사용된 상한
```

범위로 읽으세요. 2분 행과 15분 행 사이에서 결론이 바뀐다면, 그 데이터는 정밀한
주장을 지지하지 않습니다.

## 설치

Node.js **18+**, 런타임 의존성 **0개**.

```bash
git clone https://github.com/minicom365/copilot-transcript-stats.git
cd copilot-transcript-stats
npm link          # 선택: `transcript-stats` 를 PATH 에 등록
```

설치 없이 바로 실행할 수도 있습니다.

```bash
node bin/transcript-stats.js stats --latest
```

## 빠른 시작

```bash
transcript-stats list                      # 이 PC 에 있는 트랜스크립트 목록
transcript-stats stats  --latest           # 최근 세션 요약 통계
transcript-stats time   --latest           # 실효 시간: 상한별 곡선·휴식·일자별
transcript-stats tools  --latest           # 도구별 호출/실패/소요
transcript-stats segments --latest         # 사람 요청 1건당 1행
transcript-stats timeline --latest -n 40   # 원시 이벤트 스트림
transcript-stats query  --latest --role user --since 2h
transcript-stats export --latest --format md --out report.md
```

## 명령

| 명령 | 출력 |
| --- | --- |
| `list` | 발견된 트랜스크립트: 크기, 수정시각, 세션 ID, 첫 프롬프트 |
| `stats` | 대화 통계, 분량, 도구 사용, 실효 시간, 일자별 활동 |
| `time` | 시간 모델 상세: 민감도 곡선, 단계별 귀속, 휴식, 일자별 |
| `tools` | 도구별 호출 수, 실패, 인자 분량, 측정 소요시간, 평균 |
| `segments` | 사람 턴 1건당 1행: 에이전트 시간, 사고 시간, 이벤트 수, 도구 호출 |
| `timeline` | 시간순 이벤트와 직전 대비 증가분 |
| `query` | 이벤트 필터 조회 (타입/역할/도구/시간/정규식) |
| `export` | `--format json \| md \| csv` |
| `formats` | 등록된 포맷 어댑터 |
| `paths` | 트랜스크립트 탐색 디렉터리 |

### 트랜스크립트 선택

```bash
--file <path|sessionId|prefix>   파일/세션 ID/고유 접두어
--latest                         최근 수정된 트랜스크립트(기본)
--all                            이 PC 의 모든 트랜스크립트 집계
--root <dir>                     추가 VS Code user-data 디렉터리(반복 가능)
```

### 필터

```bash
--type user.message,assistant.message
--role user|assistant|tool|system
--tool run_in_terminal
--grep <regex>                          기본 대소문자 무시
--grep-scope content|args|tool|all      기본 content
--since 2026-09-01 | 90m | 2h | 3d
--until <동일 문법>
--index 100:250                         정규화 이벤트 인덱스 범위
```

### 시간 모델 옵션

```bash
--cap 5m              공백당 작업으로 인정할 최대 침묵 (기본 5m)
--break 30m           이 이상이면 중단(휴식)으로 보고 (기본 30m)
--caps 30s,1m,5m,30m  민감도 곡선 직접 지정
```

### 출력

```bash
--json / --md / --csv / --out <file> / --limit <n> / --no-color
```

## 실효 시간 계산 방식

1. 파싱 가능한 타임스탬프를 가진 이벤트를 시간순 정렬.
2. 인접 이벤트 사이 공백을 모두 더하되 각각 `--cap` 으로 자름.
3. 그 합이 **실효 시간**, 전체 구간에서 빼면 유휴 시간.

공백은 **공백을 끝낸 이벤트** 기준으로 단계에 귀속됩니다(이벤트 직전의 침묵 =
그 이벤트를 만든 시간). 도구 실행시간은 `toolCallId` 로 시작/완료를 짝지어
**정확히** 측정하므로 갭 기반 수치를 독립적으로 교차검증할 수 있습니다.

### 도구가 숨기지 않는 한계

- **도구 실행시간 ≠ 작업량.** 빌드를 5분 기다린 `run_in_terminal` 은 5분의
  *시계*이지 5분의 노력이 아닙니다.
- **상한은 도구 주기에 편향된다.** 긴 자율 도구 호출은 침묵처럼 보입니다.
- **로그는 append-only 이고 생산자만큼만 완전하다.** 타임스탬프 없는 이벤트는
  집계해 보고하며 조용히 버리지 않습니다.
- **미지의 이벤트 타입은 보존**되므로 향후 변경이 숫자를 깨뜨리지 않습니다.

## 탐색 경로

`Code`, `Code - Insiders`, `VSCodium`, `Cursor`, `Windsurf`, `Trae` 등을 자동 탐색합니다.

| OS | user-data 루트 |
| --- | --- |
| Windows | `%APPDATA%\<Product>\User` |
| macOS | `~/Library/Application Support/<Product>/User` |
| Linux | `$XDG_CONFIG_HOME/<Product>/User` (기본 `~/.config`) |

`VSCODE_USER_DIR` 환경변수 또는 `--root` 로 덮어쓸 수 있습니다.

## 라이브러리 API

```js
import { findTranscriptFiles, parseTranscript, computeStats } from 'copilot-transcript-stats';

const [newest] = await findTranscriptFiles();
const parsed = await parseTranscript(newest.file);
const stats = computeStats(parsed, { capMs: 300_000 });

console.log(stats.counts.humanTurns);   // 실제 요청 수
console.log(stats.timing.active.ms);    // 실효 시간
```

탐색·파싱·통계·타이밍·조회·렌더러가 모두 `src/index.js` 에서 export 됩니다.

## 개발

```bash
npm test        # node:test, 의존성 0, 37 스펙
```

테스트는 완전히 합성된 트랜스크립트(`test/fixtures.js`)와 손으로 계산한 기댓값을
사용하므로, 모든 시간 수치는 코드가 뱉은 스냅샷이 아니라 **검증된 산술**입니다.

## 라이선스

[MIT](LICENSE)
