# agent-chat-toolkit

**Zero-dependency CLI to analyse and navigate the agent conversations your editor keeps on disk — VS Code Copilot Chat and Antigravity.**

**한국어 문서: [README.ko.md](README.ko.md)**

Both hosts write an append-only JSONL log for every conversation and then hide it
behind a UI that only shows the current workspace. A single afternoon of agent work
produces ~10 MB and ~10,000 events. This tool reads those files and answers the
questions that actually matter:

- How many *real* asks did I make, versus how many machine events got logged?
- Which tools ran, how often did they fail, and how long did they take?
- How much wall-clock time was that, and how much of it was real work?
- Where is that conversation from last month, and how do I get it back?

```
$ agchat sessions --limit 6

 #  host         instance            updated              idx  store  head  index   title                          project                session   log       size
--  -----------  ------------------  -------------------  ---  -----  ----  ------  -----------------------------  ---------------------  --------  --------  ------
 1  vscode                            2026-10-01 09:12:41  ?    -      -             Refactoring the media pipeline  /home/me/projects/app  7132da86            65.8MB
 2  antigravity  antigravity         2026-09-28 15:43:17  yes  pb     full          Fixed the printer default      /home/me/projects/app  6f36e30a            155.8KB
 3  antigravity  antigravity         2026-09-20 11:04:52  no   db     -             Legacy conversation            /home/me/projects/app  c2d4ded1            581.5KB
 4  antigravity  antigravity-ide     2026-09-21 12:48:32  yes  pb     full          IDE build conversation         /home/me/projects/app  5f124878            780.1KB
 5  antigravity  antigravity-backup  2026-08-30 02:11:07  ?    pb     skel          Snapshot of an older profile   /home/me/projects/app  9b3f21aa            1.2MB
 6  vscode                            2026-09-28 16:49:46  ?    -      -     orphan  (unindexed chat)               /home/me/projects/app  bdc5fad2  no-log      1.9KB
```

`idx` is whether the app's own index lists the conversation. Row 3 is on disk,
readable, and **not** in the sidebar — exactly the state that makes a conversation
look lost. `head` is how complete the *content* log is: `skel` means the start of
the conversation survives only as a cleared skeleton (row 5), `lost` means it is
missing from every log. See [docs/ANTIGRAVITY.md](docs/ANTIGRAVITY.md).

> **A transcript is not necessarily the whole conversation.** On a real 9,308-step
> Antigravity session, `transcript_full.jsonl` started at step 7,231 — 78% of the
> conversation was missing from the file that looked authoritative. Antigravity
> spreads one conversation over several logs, so `agchat` merges them by
> `step_index` and reports exactly how much is readable:
>
> ```
> logs merged      transcript-full, chunk-full, transcript, chunk, overview
> steps (merged)   4,750 · step 0…9,307
> steps with text  1,342 (from step 6,380)
>   ⚠ steps 0…6,379 are skeleton only (the app cleared their text; the
>     full copy is in the encrypted <id>.pb store).
> ```
>
> The remaining text is in `conversations/<id>.pb`, which is **encrypted** (entropy
> 8.000 bits/byte) and not readable offline. Treat any total from a `skel`/`lost`
> conversation as a lower bound.
>
> The store has two generations and the **newer** one is the readable one: `.pb`
> is encrypted (2025-11 … 2026-08-13) while `.db` is plain SQLite whose blobs are
> ordinary protobuf (2026-08-03 onward). One real install holds **294 `.pb`
> conversations, 207 of which have no log at all** — for those, the only copy is
> the ciphertext, and `agchat sessions` marks them `lock`.
>
> `lock` does not mean lost: `agchat recover --session <id>` launches the bundled
> language server and exports the whole trajectory — on a real 9,308-step
> conversation whose transcript log had lost 78% of its head, it returned all
> 9,308 steps (56.9 MB).
>
> What *is* lost is what the app cleared: a step whose status is
> `CORTEX_STEP_STATUS_CLEARED` keeps its metadata and nothing else, on disk. One
> measured conversation had 27,560 of 27,561 steps cleared, so the export is a
> complete record of a thin conversation. See `docs/MIGRATION.md`.

---

## What it does

| command | purpose |
| --- | --- |
| **`sessions`** | one catalog across every host, instance, workspace and profile — including conversations the editor has "forgotten" |
| **`find`** | keyword search with four detail levels, so tool noise never buries the decision you are looking for |
| **`show`** | replay one conversation at the level of detail you need |
| **`move`** | migrate a VS Code conversation into another workspace's storage, with backups and a dry-run default |
| **`orphans`** | workspace storages that still hold conversations for a folder that no longer exists |
| **`migrate`** | move an Antigravity conversation between instances, and file it under another project space |
| **`recover`** | export the *full* encrypted store of an Antigravity conversation through its language server |
| **`stats` / `time` / `tools`** | conversation statistics, tool usage and a defensible estimate of effective development time |
| **`query` / `timeline` / `export`** | raw event access as text, JSON, Markdown or CSV |

## Why this exists

### 1. Tool traffic is mixed into the conversation

A transcript interleaves three unrelated kinds of record:

| kind | VS Code | Antigravity | meaning |
| --- | --- | --- | --- |
| conversation | `user.message`, `assistant.message` | `USER_INPUT`, `PLANNER_RESPONSE` | a human asked, the model answered |
| bookkeeping | `assistant.turn_start/_end` | — | the agent's own loop |
| tool round-trips | `tool.execution_start/_complete` | `GENERIC`, `RUN_COMMAND`, `VIEW_FILE`, … | the agent used a tool |

Counting raw lines gives a number dominated by machine bookkeeping. In one real
session, **79% of the log was neither a human nor a model message**. The tool reports
each kind separately and prints the ratios, so the contamination is visible instead of
implied.

### 2. Wall-clock span is not working time

A transcript records *when an event was written*, nothing else. The span between the
first and last event includes lunch, the weekend, and the editor left open overnight.
A four-day session is not four days of work.

### 3. Every "time spent" number is a model, so the model is shown

The tool sums the silences between consecutive events, capping each silence at a
threshold (default 5 minutes). Below the cap is assumed to be "still working"; above it
is assumed to contain a break. The threshold is a **judgement, not a measurement**, so
the whole sensitivity curve is printed instead of a single number pretending to be the
truth:

```
  Sensitivity of the cap (the cap is a modelling choice, not a measurement):
cap / gap  effective time        idle  active ratio
---------  --------------  ----------  ------------
      30s          1h 50m  1d 4h 22m          6.1%
       1m          2h 20m  1d 3h 52m          7.7%
       2m          2h 58m  1d 3h 14m          9.8%
     5m *          4h 3m   1d 2h 9m         13.4%
      15m          4h 51m  1d 1h 21m         16.0%
      30m          5h 40m  1d 0h 33m         18.7%
  * = cap used for the headline number
```

Read it as a range. If the answer you need changes between the 2m and the 15m row, the
data does not support a precise claim.

### 4. Conversations get orphaned, and the editor will not tell you

A session can exist on disk with no entry in the history panel, because the index lost
it or because its files landed in a *different* `workspaceStorage` folder for the same
workspace. `sessions` marks those as `orphan`, and `move` is the repair.

---

## Install

Requires **Node.js 18+**. There are no runtime dependencies.

```bash
git clone https://github.com/minicom365/agent-chat-toolkit.git
cd agent-chat-toolkit
npm link          # optional: makes `agchat` available on PATH
```

```bash
node bin/agchat.js hosts           # what did it find on this machine?
node bin/agchat.js sessions        # list every conversation, newest first
node bin/agchat.js stats --latest  # analyse the most recent one
```

## Hosts and instances

| host | where the conversations live |
| --- | --- |
| `vscode` | `<User>/workspaceStorage/<hash>/` — `chatSessions/*.jsonl`, `GitHub.copilot-chat/transcripts/*.jsonl`, `state.vscdb` index |
| `antigravity` | `~/.gemini/<instance>/brain/<id>/.system_generated/logs/` — `transcript*.jsonl`, `overview.txt`, `chunks/**` + `conversation_summaries.db` |

An **instance** is one install or snapshot of a host. Antigravity keeps several:
`antigravity` (the app), `antigravity-ide` (the IDE build), `antigravity-backup`
(a snapshot of an older profile) and `antigravity-history` (a third-party cache).
They are discovered generically as `~/.gemini/*antigravity*` and catalogued
separately, so conversations that only exist in a backup are still found.

See [docs/HOSTS.md](docs/HOSTS.md) for the full layout of both, including the SQLite
schemas and the pitfalls that make naive parsing wrong, and
[docs/ANTIGRAVITY.md](docs/ANTIGRAVITY.md) for what is plaintext, what is protobuf,
and why the language server is not needed.

Product directories searched for VS Code: `Code`, `Code - Insiders`, `VSCodium`,
`Cursor`, `Windsurf`, `Trae`, `Code - OSS`, `Code - Exploration` — on Windows, macOS
and Linux. Override with `VSCODE_USER_DIR` / `GEMINI_DIR` /
`ANTIGRAVITY_PROFILE_DIR`, or `--root <dir>`.

## Commands

| command | what it prints |
| --- | --- |
| `hosts` | detected hosts, data roots, conversation counts, total size |
| `sessions` (alias `list`) | every conversation across hosts and instances: title, project, id, size, index state |
| `find` | keyword search across conversations, at detail level 1–4 |
| `show` | one conversation (`-s <id>`) at a detail level |
| `move` | copy a VS Code conversation into another workspace storage (dry run by default) |
| `stats` | conversation statistics, volume, tool usage, effective time, per-day activity |
| `time` | the time model in detail: sensitivity curve, phase attribution, breaks, per day |
| `tools` | per-tool calls, failures, argument volume, measured runtime, mean |
| `segments` | one row per human turn: agent time, think time, event count, tool calls |
| `timeline` | chronological events with the delta to the previous event |
| `query` | filtered event list (type / role / tool / time / regex) |
| `export` | `--format json \| md \| csv` |
| `formats` | registered transcript format adapters |
| `paths` | directories searched for transcripts |

### Detail levels (`find`, `show`)

| level | name | contains | use it for |
| --- | --- | --- | --- |
| **1** | compact | human requests only, hard truncated | scanning what you asked for |
| **2** | dialogue | + model prose (no tools, no output) | recovering the decision and its reasoning |
| **3** | actions | + one-line tool badges with status | following what actually changed |
| **4** | audit | + tool output, arguments, raw payloads | debugging a failure |

Search is level-aware: a level-2 search can never be buried by a tool log.

```bash
agchat find -k "migration" -l 2 --max-results 5
agchat find -k "ETIMEDOUT" -l 4 --grep-scope output
agchat show -s 6f36e30a -l 3 > conversation.md
```

### Selecting a conversation

```bash
-s, --session <id|prefix|title>   conversation id, unique prefix, or title substring
-f, --file <path|prefix>          explicit transcript file
    --latest                      most recent transcript across hosts (default)
    --all                         aggregate every discovered transcript
    --host <vscode|antigravity>   restrict to one host (repeatable)
    --instance <name>             restrict to one instance (e.g. backup, ide)
    --not-indexed                 data on disk but not listed by the app's index
    --recoverable                 ... and readable here (has a transcript)
    --root <dir>                  extra data dir to search (repeatable)
```

### Filters

```bash
--type user.message,assistant.message       event type(s)
--role user|assistant|tool|system
--tool run_in_terminal
--grep <regex>                              case-insensitive unless you add (?-i)
--grep-scope content|args|output|tool|all   default: content
--since 2026-09-01 | 90m | 2h | 3d
--until <same syntax>
--index 100:250                             normalised event index range
```

### Time-model knobs

```bash
--cap 5m               silence counted as work, per gap (default 5m)
--break 30m            silence reported as an interruption (default 30m)
--caps 30s,1m,5m,30m   override the sensitivity curve
```

### Output

```bash
--json / --md / --csv / --out <file> / --limit <n> / --no-color
```

---

## Moving a conversation between workspaces

`move` copies a VS Code conversation (chat state + agent transcript + history index
entry) from the storage folder that owns it into another one, so it reappears in a
different window. It is built to be impossible to run by accident:

```bash
# 1. see what would happen (nothing is written)
agchat move -s 6f36e30a --to bbbb2222 --data-dir ~/.config/Code/User

# 2. do it (only after the editor is closed)
agchat move -s 6f36e30a --to bbbb2222 --data-dir ~/.config/Code/User --apply
```

- `--data-dir` is **required** — there is no implicit target.
- Default is a **dry run**; `--apply` is required to write.
- `--apply` into an OS-default profile is refused unless `--i-know-what-im-doing` (the
  dry run is still allowed, and warns you).
- Writing while the editor is running is refused (it would clobber the in-memory index
  on the next flush) unless `--allow-running`.
- `state.vscdb` is copied to a timestamped `.bak-…` before the first write.
- The source is **never** modified and nothing is ever deleted.
- Re-running is idempotent.

See [docs/SAFETY.md](docs/SAFETY.md).

## Sandbox verification

Everything is verified against a synthetic data tree, in a throwaway container, so the
checks never touch a live profile:

```bash
npm run verify                 # unit suite + sandbox E2E on the host
npm run sandbox                # sandbox E2E only (generates a temp tree and removes it)

docker build -f Dockerfile.verify -t agchat-verify .
docker run --rm --network none agchat-verify
```

The sandbox generates fake VS Code storages (including `state.vscdb` and an orphaned
session) and a fake Antigravity brain, then asserts that a migration leaves its source
byte-identical, takes a backup, merges the index, and stays idempotent.

## Effective time model

1. Every event with a parsable timestamp is sorted chronologically.
2. The gaps between consecutive events are summed, each capped at `--cap`.
3. That sum is the **effective time**; span minus effective time is idle.

Gaps are attributed to a phase by the event that *ends* the gap, because the silence
before an event is the time spent producing it:

```
phase                                              gaps         raw  capped(5m)
------------------------------------------------  -----  ----------  ----------
human think time (gap before a user message)         19     19h 40m         48m
model generation (gap before an assistant event)    812      8h 12m       1h 12m
tool execution (gap before a tool completion)       419      2h 3m        2h 3m
```

Tool runtime is *also* measured exactly by pairing a call with its result, so the
gap-based number can be cross-checked.

### Caveats the tool will not hide

- **Tool runtime is not effort.** A `run_in_terminal` that waited five minutes for a
  build is five minutes of *clock*, not of work.
- **Caps are biased by tool cadence.** A long autonomous tool call looks like a
  silence. Raise `--cap` if you run long builds; lower it if you step away often.
- **The log is only as complete as the producer.** Missing timestamps are counted and
  reported, never silently dropped.
- **Unknown event types are preserved**, so a producer update does not break the
  numbers.

## Library API

```js
import { allSessions, parseTranscript, computeStats, findSession } from 'agent-chat-toolkit';

const sessions = await allSessions();                     // both hosts
const one = findSession(sessions, '6f36e30a');
const parsed = await parseTranscript(one.transcriptPath);
const stats = computeStats(parsed, { capMs: 300_000 });

console.log(stats.format);           // antigravity-transcript | vscode-transcript
console.log(stats.counts.humanTurns);
console.log(stats.timing.active.ms);
```

Everything is exported from `src/index.js`: hosts, discovery, parsing, statistics,
timing, search, querying, migration and every renderer.

## Adding a format adapter

`src/formats/*.js` maps one on-disk format onto the normalised event shape
(`{ type, role, ts, text, observation, toolName, success, argsText, … }`). Implement
`looksLike()` + `normalize()` (+ optional `finalize()` for cross-event pairing such as
request/result matching) and register it in `src/formats/index.js`. The analysis layer
never touches raw JSON.

`src/formats/vscode-transcript.js` is the worked example of a request/result format;
`src/formats/antigravity-transcript.js` is the worked example of a combined event
format.

## Development

```bash
npm run verify     # 65 unit specs + 58 sandbox checks
```

The unit tests are built on fully synthetic transcripts with hand-computed
expectations, so every timing number is verified arithmetic rather than a snapshot of
whatever the code happened to output.

## License

[MIT](LICENSE)
