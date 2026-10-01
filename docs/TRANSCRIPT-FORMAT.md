# Transcript wire format

Notes on the on-disk format consumed by the built-in `vscode-transcript` adapter.
Everything here was derived by reading real transcripts; it is a descriptive
reference, not an official specification.

## Location

```
<User>/workspaceStorage/<workspace-hash>/GitHub.copilot-chat/transcripts/<sessionId>.jsonl
```

`<User>` is the VS Code user-data directory (see the README for per-OS paths).
Files are **append-only**: a session that is still open keeps growing, and the last
event can be a `assistant.turn_start` whose partner has not been written yet.

## Envelope

One JSON object per line:

```jsonc
{
  "type": "assistant.message",
  "data": { /* type specific */ },
  "id": "b4bd8dd2-…",          // event id
  "timestamp": "2026-01-01T00:00:00.000Z",
  "parentId": "…"              // causal parent, null for session.start
}
```

The tool ignores `parentId` for statistics but preserves `id`/`parentId` so callers
can rebuild the causal tree.

## Event types

| type | `data` fields | notes |
| --- | --- | --- |
| `session.start` | `sessionId`, `version`, `producer`, `copilotVersion`, `vscodeVersion`, `startTime` | always the first line |
| `user.message` | `content`, `attachments[]` | the only human-authored event |
| `assistant.turn_start` | `turnId` | bookkeeping, no content |
| `assistant.message` | `messageId`, `content`, `toolRequests[]`, `reasoningText?` | `toolRequests[].name` is what the model *asked* to run |
| `assistant.turn_end` | `turnId` | bookkeeping, no content |
| `tool.execution_start` | `toolCallId`, `toolName`, `arguments` | `arguments` is a JSON object |
| `tool.execution_complete` | `toolCallId`, `success` | join to the start event on `toolCallId` |

Unknown types are kept. `data` shapes may grow; the adapter only reads the fields it
needs and never assumes a field is present.

## Traps worth knowing

1. **Three kinds of "turn".** `assistant.turn_start` fires for every agent loop
   iteration, including one per tool round-trip. Counting turn markers as
   "conversation turns" inflates the count by one to two orders of magnitude.
2. **`toolRequests` ≠ executions.** The model can request a tool that is denied or
   never started, and a single request can produce several executions.
3. **Parallel tool calls interleave.** Two `tool.execution_start` events can appear
   before either completes, and event order can disagree with timestamp order by a
   few milliseconds. The timing layer sorts by timestamp and breaks ties on the
   original index.
4. **`success` is sometimes absent.** `tool.execution_complete` carries a boolean
   in current builds, but older builds and some producers omit it. Missing values
   are reported as `unknown`, not as failures.
5. **Timestamps are ISO-8601 UTC** with milliseconds. Events with an unparsable
   timestamp are counted in `counts.undatedEvents` and excluded from all timing.
6. **Arguments are machine text.** They dominate the byte count (often more than the
   model's prose) and must never be counted as human writing.
7. **Screenshot/binary payloads are not inlined**, but some `tool.execution_*`
   payloads are large. The adapter caps retained argument text at 8,000 characters
   for `--grep-scope args`; the full blob is never loaded for statistics runs.

## Not this format

`<User>/workspaceStorage/<hash>/chatSessions/*.jsonl` is a different file: a
patch/operation log whose first line is `{"kind":0,"v":{"version":3,…}}` followed by
state deltas. It is the chat *state*, not the agent event stream, and is not parsed
by this tool. `looksLike()` rejects it on purpose.
