# copilot-transcript-stats

**Zero-dependency CLI that turns VS Code Copilot Chat agent transcripts into conversation statistics, tool-usage breakdowns and a defensible estimate of effective development time.**

**한국어 문서: [README.ko.md](README.ko.md)**

VS Code writes an append-only JSONL event log for every agent chat session
(`…/User/workspaceStorage/<hash>/GitHub.copilot-chat/transcripts/<session>.jsonl`).
Those files are goldmines — and completely unreadable. A single afternoon of agent
work produces ~10 MB and ~10,000 events. `copilot-transcript-stats` reads them and
answers the questions you actually have:

- How many *real* asks did I make, versus how many machine events got logged?
- Which tools ran, how often did they fail, and how long did they actually take?
- How much wall-clock time was that, and how much of it was real work?

```
$ transcript-stats stats --latest

1. Conversation statistics
────────────────────────────────────────────────────────────────────────
human turns (user.message)       5
assistant messages               412
agent turn markers (turn_start)  418
tool calls executed              419 (3 failed)
tool calls requested by model    421
total events (raw lines)         1,986

  Derived ratios (this is where tool traffic contaminates naive counts):
agent markers per human turn   83.60
tool calls per human turn      83.80
machine-only line share        83.5%
```

---

## Why this exists

Three traps make naive transcript analysis wrong, and this tool is built
specifically to avoid them.

### 1. Tool traffic is mixed into the conversation

A transcript interleaves three unrelated kinds of records:

| kind | event types | meaning |
| --- | --- | --- |
| conversation | `user.message`, `assistant.message` | a human asked, the model answered |
| bookkeeping | `assistant.turn_start`, `assistant.turn_end` | the agent's own loop markers |
| tool round-trips | `tool.execution_start`, `tool.execution_complete` | the agent used a tool |

Counting raw lines gives a number dominated by machine bookkeeping — in the example
above, **83.5% of the log is neither a human nor a model message**. The tool reports
them separately and shows the ratios explicitly so you can see the contamination.
### 2. Wall-clock span is not working time

A transcript records *when an event was written*, nothing else. The span between the
first and last event includes lunch, the weekend, and the editor left open overnight.
A four-day session is not four days of work.

### 3. Every "time spent" number is a model, so the model is shown

The tool sums the silences between consecutive events, but caps each silence at a
threshold (default 5 minutes). Anything below the cap is assumed to be "still
working"; anything above it is assumed to contain a break. The threshold is a
**judgement, not a measurement**, so the tool prints the whole sensitivity curve
rather than a single number pretending to be the truth:

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

Read it as a range. If the answer you need changes between the 2m and the 15m row,
the data does not support a precise claim.

---

## Install

Requires **Node.js 18+**. There are no runtime dependencies.

```bash
git clone https://github.com/minicom365/copilot-transcript-stats.git
cd copilot-transcript-stats
npm link          # optional: makes `transcript-stats` available on PATH
```

Or run it directly without installing:

```bash
node bin/transcript-stats.js stats --latest
```

## Quick start

```bash
transcript-stats list                      # what transcripts exist on this machine
transcript-stats stats  --latest           # summary of the most recent session
transcript-stats time   --latest           # effective time: caps, breaks, per day
transcript-stats tools  --latest           # tool usage and failures
transcript-stats segments --latest         # one row per human ask
transcript-stats timeline --latest -n 40   # raw event stream
transcript-stats query  --latest --role user --since 2h
transcript-stats export --latest --format md --out report.md
```

## Commands

| command | what it prints |
| --- | --- |
| `list` | every discovered transcript: size, modified time, session id, first prompt |
| `stats` | conversation statistics, volume, tool usage, effective time, per-day activity |
| `time` | the time model in detail: sensitivity curve, phase attribution, breaks, per day |
| `tools` | per-tool call count, failures, argument volume, measured runtime, mean |
| `segments` | one row per human turn: agent time, think time, event count, tool calls |
| `timeline` | chronological events with the delta to the previous event |
| `query` | filtered event list (type / role / tool / time / regex) |
| `export` | `--format json \| md \| csv` |
| `formats` | registered format adapters |
| `paths` | directories searched for transcripts |

### Selecting a transcript

```bash
--file <path|sessionId|prefix>   explicit file, session id, or unique prefix
--latest                         most recently modified transcript (default)
--all                            aggregate every transcript on the machine
--root <dir>                     extra VS Code user-data dir to search (repeatable)
```

`--file` accepts a full path, a session id, a unique prefix of one
(`--file a1b2c3d4`), or any substring of the path.

### Filters

```bash
--type user.message,assistant.message   event type(s)
--role user|assistant|tool|system
--tool run_in_terminal
--grep <regex>                          case-insensitive unless you add (?-i)
--grep-scope content|args|tool|all      default: content
--since 2026-09-01 | 90m | 2h | 3d
--until <same syntax>
--index 100:250                         normalised event index range
```

### Time-model knobs

```bash
--cap 5m            silence counted as work, per gap (default 5m)
--break 30m         silence reported as an interruption (default 30m)
--caps 30s,1m,5m,30m   override the sensitivity curve
```

### Output

```bash
--json          machine-readable output
--md            markdown (export)
--csv           csv (export)
--out <file>    write to a file instead of stdout
--limit <n>     cap rows / events
--no-color      disable ANSI colour
```

---

## How effective time is computed

```
effective time (cap 5m)   4h 3m  = 13.4% of span
idle (breaks + untouched)        1d 2h 9m
breaks > 30m                     3
```

1. Every event with a parsable timestamp is sorted chronologically.
2. The gaps between consecutive events are summed, each capped at `--cap`.
3. That sum is the **effective time**. Span minus effective time is idle.

Gaps are also attributed to a phase by the event that *ends* the gap, because the
silence before an event is the time spent producing it:

```
phase                                              gaps         raw  capped(5m)
------------------------------------------------  -----  ----------  ----------
human think time (gap before a user message)         19     19h 40m         48m
model generation (gap before an assistant event)    812      8h 12m       1h 12m
tool execution (gap before a tool completion)       419      2h 3m        2h 3m

  human 48m + agent 1h 12m + tool 2h 3m ≈ 4h 3m
```

Tool runtime is *also* measured exactly by pairing `tool.execution_start` with
`tool.execution_complete` on `toolCallId`, so you get an independent check on the
gap-based number.

### Caveats that the tool will not hide from you

- **Tool runtime is not work.** A `run_in_terminal` call that waited five minutes for
  a build, or for you to answer a prompt, is five minutes of *clock*, not of effort.
- **Caps are biased by tool cadence.** A long autonomous tool call looks like a
  silence. Raise `--cap` if you run long builds; lower it if you step away often.
- **The log is append-only and only as complete as the producer.** Missing
  timestamps are counted and reported, never silently dropped.
- **Unknown event types are preserved**, not discarded, so future producers do not
  break the numbers.

---

## Discovery

Transcripts are found automatically for `Code`, `Code - Insiders`, `VSCodium`,
`Cursor`, `Windsurf`, `Trae` and similar builds:

| OS | user-data root |
| --- | --- |
| Windows | `%APPDATA%\<Product>\User` |
| macOS | `~/Library/Application Support/<Product>/User` |
| Linux | `$XDG_CONFIG_HOME/<Product>/User` (default `~/.config`) |

Override with `VSCODE_USER_DIR=/path/to/User` or `--root`.

## Library API

```js
import { findTranscriptFiles, parseTranscript, computeStats } from 'copilot-transcript-stats';

const [newest] = await findTranscriptFiles();
const parsed = await parseTranscript(newest.file);
const stats = computeStats(parsed, { capMs: 300_000 });

console.log(stats.counts.humanTurns);      // real asks
console.log(stats.timing.active.ms);       // effective time
console.log(stats.tools[0]);               // busiest tool
```

Everything is exported from `src/index.js`: discovery, parsing, statistics, timing,
querying and every renderer.

## Adding a format adapter

`src/formats/vscode-transcript.js` is intentionally a small, isolated module that maps
one on-disk format onto the normalised event shape (`{ type, role, ts, text, toolName,
success, argsText, … }`). To support another producer, implement
`looksLike()` + `normalize()` and register it. The analysis layer never touches raw
JSON. See [docs/TRANSCRIPT-FORMAT.md](docs/TRANSCRIPT-FORMAT.md) for the wire format.

Note that VS Code `chatSessions/*.jsonl` is a *different* format (a patch/operation
log, not an event log) and is deliberately not parsed here.

## Development

```bash
npm test        # node:test, no dependencies, 37 specs
```

The test-suite is built on fully synthetic transcripts (`test/fixtures.js`) with
hand-computed expectations, so every timing number is verified arithmetic rather than
a snapshot of whatever the code happened to output.

## License

[MIT](LICENSE)
