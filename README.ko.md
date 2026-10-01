# copilot-transcript-stats

**에디터가 디스크에 남기는 에이전트 대화를 분석·탐색하는 의존성 없는 CLI — VS Code Copilot Chat 과 Antigravity.**

**English: [README.md](README.md)**

두 호스트 모두 대화마다 append-only JSONL 로그를 남기지만, UI는 현재 워크스페이스만
보여줍니다. 오후 한나절 작업이면 약 10MB / 1만 이벤트가 쌓입니다. 이 도구는 그
파일을 읽어 실제로 궁금한 것에 답합니다.

- **실제 요청**은 몇 번이었고, 기계 이벤트는 얼마나 섞여 있는가?
- 어떤 도구가 얼마나 돌았고, 몇 번 실패했고, 실제로 얼마나 걸렸는가?
- 벽시계 시간은 얼마였고, 그중 진짜 작업은 얼마인가?
- 지난달 그 대화는 어디에 있고, 어떻게 되찾는가?

```
$ transcript-stats sessions --limit 6

 #  host         updated              index   title                          project                session   log       size
--  -----------  -------------------  ------  -----------------------------  ---------------------  --------  --------  ------
 1  vscode       2026-10-01 09:12:41          Refactoring the media pipeline  /home/me/projects/app  7132da86            65.8MB
 2  antigravity  2026-09-28 15:43:17          Sandbox antigravity session     /home/me/projects/app  6f36e30a            155.8KB
 3  vscode       2026-09-28 16:49:46  orphan  (unindexed chat)               /home/me/projects/app  bdc5fad2  no-log      1.9KB
```

---

## 무엇을 하는가

| 명령 | 목적 |
| --- | --- |
| **`sessions`** | 호스트·워크스페이스·프로필을 넘나드는 단일 대화 목록 — 에디터가 "잊어버린" 대화 포함 |
| **`find`** | 4단계 상세도 키워드 검색 — 도구 로그에 묻히지 않음 |
| **`show`** | 필요한 상세도로 대화 1건 재생 |
| **`move`** | VS Code 대화를 다른 워크스페이스 스토리지로 이전 (기본 dry-run, 자동 백업) |
| **`stats` / `time` / `tools`** | 대화 통계, 도구 사용, 실효 개발시간 추정 |
| **`query` / `timeline` / `export`** | 원시 이벤트 접근 (텍스트/JSON/Markdown/CSV) |

## 왜 필요한가 (도구가 피해가는 네 가지 함정)

1. **도구 호출이 대화에 섞여 있다.** 트랜스크립트는 세 종류 레코드를 뒤섞습니다.

   | 종류 | VS Code | Antigravity | 의미 |
   | --- | --- | --- | --- |
   | 대화 | `user.message`, `assistant.message` | `USER_INPUT`, `PLANNER_RESPONSE` | 사람이 묻고 모델이 답함 |
   | 부기 | `assistant.turn_start/_end` | — | 에이전트 자체 루프 |
   | 도구 왕복 | `tool.execution_start/_complete` | `GENERIC`, `RUN_COMMAND`, `VIEW_FILE` … | 도구 실행 |

   실측 세션 하나에서 **로그의 79%가 사람/모델 메시지가 아니었습니다.** 도구는 종류별로
   분리 집계하고 비율을 명시적으로 출력합니다.

2. **벽시계 구간은 작업시간이 아니다.** 4일짜리 세션이 4일치 작업일 수 없습니다.

3. **모든 "소요 시간"은 모델이므로, 모델을 공개한다.** 연속 이벤트 사이 공백을 합산하되
   각 공백을 임계값(기본 5분)으로 자릅니다. 임계값은 **판단**이므로 민감도 곡선 전체를
   출력합니다.

   ```
   cap / gap  effective time        idle  active ratio
   ---------  --------------  ----------  ------------
         30s          1h 50m  1d 4h 22m          6.1%
          1m          2h 20m  1d 3h 52m          7.7%
        5m *          4h 3m   1d 2h 9m         13.4%
         30m          5h 40m  1d 0h 33m         18.7%
     * = 기본(headline) 계산에 사용된 상한
   ```

   범위로 읽으세요. 2분 행과 15분 행 사이에서 결론이 바뀐다면 정밀한 주장은 무리입니다.

4. **대화는 고아가 되고, 에디터는 알려주지 않는다.** 인덱스가 잃어버렸거나 같은
   워크스페이스의 *다른* `workspaceStorage` 폴더에 파일이 떨어진 경우, 파일은 있는데
   히스토리 패널에 안 보입니다. `sessions`는 이를 `orphan`으로 표시하고 `move`가 복구합니다.

## 설치

Node.js **18+**, 런타임 의존성 **0개**.

```bash
git clone https://github.com/minicom365/copilot-transcript-stats.git
cd copilot-transcript-stats
npm link
```

## 호스트

| 호스트 | 대화가 있는 곳 |
| --- | --- |
| `vscode` | `<User>/workspaceStorage/<hash>/` — `chatSessions/*.jsonl`, `GitHub.copilot-chat/transcripts/*.jsonl`, `state.vscdb` 인덱스 |
| `antigravity` | `~/.gemini/antigravity*/brain/<id>/.system_generated/logs/transcript*.jsonl` + `conversation_summaries.db` |

전체 레이아웃과 SQLite 스키마, 파싱 함정은 [docs/HOSTS.md](docs/HOSTS.md) 참고.

VS Code 탐색 대상: `Code`, `Code - Insiders`, `VSCodium`, `Cursor`, `Windsurf`, `Trae`
(Windows/macOS/Linux). `VSCODE_USER_DIR` / `GEMINI_DIR` 또는 `--root <dir>`로 덮어쓸 수
있습니다.

## 상세도 레벨 (`find`, `show`)

| 레벨 | 이름 | 포함 | 용도 |
| --- | --- | --- | --- |
| **1** | compact | 사람 요청만, 강한 절단 | 내가 뭘 시켰는지 훑기 |
| **2** | dialogue | + 모델 산문 (도구·출력 제외) | 결정과 근거 복원 |
| **3** | actions | + 한 줄 도구 배지(상태 포함) | 실제로 무엇이 바뀌었는지 |
| **4** | audit | + 도구 출력·인자·원시 페이로드 | 실패 원인 디버깅 |

검색은 레벨 인지형입니다. 레벨 2 검색은 도구 로그에 묻히지 않습니다.

```bash
transcript-stats find -k "마이그레이션" -l 2 --max-results 5
transcript-stats find -k "ETIMEDOUT" -l 4 --grep-scope output
transcript-stats show -s 6f36e30a -l 3 > 대화.md
```

## 대화 이전 (`move`)

VS Code 대화(채팅 상태 + 에이전트 트랜스크립트 + 히스토리 인덱스 엔트리)를 다른
스토리지 폴더로 복사해 다른 창에서 다시 나타나게 합니다. 실수로 실행될 수 없게 설계했습니다.

```bash
# 1. 계획만 확인 (아무것도 쓰지 않음)
transcript-stats move -s 6f36e30a --to bbbb2222 --data-dir ~/.config/Code/User

# 2. 실행 (에디터를 완전히 종료한 뒤에만)
transcript-stats move -s 6f36e30a --to bbbb2222 --data-dir ~/.config/Code/User --apply
```

- `--data-dir` **필수** — 암묵적 대상이 없습니다.
- 기본은 **dry-run**, 쓰려면 `--apply`.
- OS 기본 프로필에 `--apply` 하려면 `--i-know-what-im-doing` 없이는 거부됩니다(dry-run 미리보기는 허용되고 경고를 출력합니다).
- 에디터 실행 중에는 거부(다음 flush 때 인메모리 인덱스가 덮어씀). `--allow-running`으로만 우회.
- 첫 쓰기 전에 `state.vscdb`를 타임스탬프 백업(`.bak-…`)으로 복사.
- **원본은 절대 수정하지 않고, 아무것도 삭제하지 않습니다.**
- 재실행은 멱등(no-op)입니다.

자세한 내용은 [docs/SAFETY.md](docs/SAFETY.md).

## 샌드박스 검증

실제 프로필을 건드리지 않도록, 합성 데이터 트리와 일회용 컨테이너에서 전체를 검증합니다.

```bash
npm run verify     # 단위 테스트 + 샌드박스 E2E
npm run sandbox    # 샌드박스 E2E만 (임시 트리 생성 후 삭제)

docker build -f Dockerfile.verify -t transcript-stats-verify .
docker run --rm --network none transcript-stats-verify
```

샌드박스는 가짜 VS Code 스토리지(`state.vscdb`, 고아 세션 포함)와 가짜 Antigravity
브레인을 만들고, 이전 작업이 **원본을 바이트 단위로 그대로 두는지**, 백업을 남기는지,
인덱스를 병합하는지, 재실행이 멱등인지 검증합니다.

## 실효 시간 모델

1. 파싱 가능한 타임스탬프를 가진 이벤트를 시간순 정렬.
2. 인접 이벤트 사이 공백을 모두 더하되 각각 `--cap` 으로 자름.
3. 그 합이 **실효 시간**, 전체 구간에서 빼면 유휴 시간.

공백은 **공백을 끝낸 이벤트** 기준으로 단계에 귀속됩니다. 도구 실행시간은 호출-결과를
짝지어 **정확히** 측정하므로 갭 기반 수치를 교차검증할 수 있습니다.

### 도구가 숨기지 않는 한계

- **도구 실행시간 ≠ 작업량.** 빌드를 5분 기다린 호출은 5분의 *시계*입니다.
- **상한은 도구 주기에 편향된다.** 긴 자율 도구 호출은 침묵처럼 보입니다.
- **로그는 생산자만큼만 완전하다.** 타임스탬프 없는 이벤트는 집계해 보고합니다.
- **미지의 이벤트 타입은 보존**되므로 향후 변경이 숫자를 깨뜨리지 않습니다.

## 라이브러리 API

```js
import { allSessions, parseTranscript, computeStats, findSession } from 'copilot-transcript-stats';

const sessions = await allSessions();                     // 두 호스트 모두
const one = findSession(sessions, '6f36e30a');
const parsed = await parseTranscript(one.transcriptPath);
const stats = computeStats(parsed, { capMs: 300_000 });
```

## 개발

```bash
npm run verify     # 55 단위 스펙 + 46 샌드박스 검사
```

테스트는 완전히 합성된 트랜스크립트와 손으로 계산한 기댓값을 사용하므로, 모든 시간
수치는 코드가 뱉은 스냅샷이 아니라 **검증된 산술**입니다.

## 라이선스

[MIT](LICENSE)
