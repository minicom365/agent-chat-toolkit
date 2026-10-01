# Transcript wire formats

Both supported formats are append-only JSONL event logs, but they disagree on almost
everything else. This is the reference for both adapters
(`src/formats/vscode-transcript.js`, `src/formats/antigravity-transcript.js`).

For *where* the files live and how they are indexed, see [HOSTS.md](HOSTS.md).

| | VS Code Copilot Chat | Antigravity |
| --- | --- | --- |
| envelope keys | `type`, `data`, `id`, `parentId`, `timestamp` | `step_index`, `source`, `type`, `status`, `created_at` |
| ordering key | `timestamp` (ms, ISO-8601) | `step_index` (ms timestamps collide) |
| event id | UUID + causal `parentId` | none |
| human message | `user.message` (`data.content`) | `USER_INPUT` (`content`, wrapped in `<USER_REQUEST>`) |
| model message | `assistant.message` (`data.content`, `data.reasoningText`) | `PLANNER_RESPONSE` (`content`, `thinking`) |
| tool call | `tool.execution_start` + `tool.execution_complete` pair | `PLANNER_RESPONSE.tool_calls[]` + a later result event |
| tool result | the `…complete` event (`success` boolean) | its own event typed by tool kind |
| tool naming | `data.toolName` | the result event's `type`, paired back to the request |
| tool args | `data.arguments` (camelCase) | `tool_calls[].args` (PascalCase, values are quoted JSON strings) |
| argument cap | 8,000 chars retained for `--grep-scope args` | same |

---

## VS Code Copilot Chat event log

```
<User>/workspaceStorage/<hash>/GitHub.copilot-chat/transcripts/<sessionId>.jsonl
```

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

### Event types

| type | `data` fields | notes |
| --- | --- | --- |
| `session.start` | `sessionId`, `version`, `producer`, `copilotVersion`, `vscodeVersion`, `startTime` | always the first line |
| `user.message` | `content`, `attachments[]` | the only human-authored event |
| `assistant.turn_start` | `turnId` | bookkeeping, no content |
| `assistant.message` | `messageId`, `content`, `toolRequests[]`, `reasoningText?` | `toolRequests[].name` is what the model *asked* to run |
| `assistant.turn_end` | `turnId` | bookkeeping, no content |
| `tool.execution_start` | `toolCallId`, `toolName`, `arguments` | `arguments` is a JSON object |
| `tool.execution_complete` | `toolCallId`, `success` | join to the start event on `toolCallId` |

Unknown types are kept, and `data` may grow: the adapter reads only the fields it needs
and never assumes one is present.

### Traps

1. **Three kinds of "turn".** `assistant.turn_start` fires for every agent loop
   iteration, including one per tool round-trip. Counting turn markers as "conversation
   turns" inflates the count by one to two orders of magnitude.
2. **`toolRequests` ≠ executions.** The model can request a tool that is denied or never
   started, and one request can produce several executions.
3. **Parallel tool calls interleave.** Two `tool.execution_start` events can appear
   before either completes, and event order can disagree with timestamp order by a few
   milliseconds. The timing layer sorts by timestamp and breaks ties on the original
   index; the pairing layer joins on `toolCallId`, never on adjacency.
4. **`success` is sometimes absent.** Missing values are reported as `unknown`, not as
   failures.
5. **Timestamps are ISO-8601 UTC with milliseconds.** Events with an unparsable
   timestamp are counted in `counts.undatedEvents` and excluded from all timing.
6. **Arguments dominate the byte count** — often more than the model's prose. They are
   machine text and are never counted as human writing.

---

## Antigravity step log

```
~/.gemini/<appDataDir>/brain/<conversationId>/.system_generated/logs/overview.txt           full skeleton, text elided for all but the newest steps
~/.gemini/<appDataDir>/brain/<conversationId>/.system_generated/logs/transcript_full.jsonl   content log (can lose the head)
~/.gemini/<appDataDir>/brain/<conversationId>/.system_generated/logs/transcript.jsonl        capped twin of the above
~/.gemini/<appDataDir>/brain/<conversationId>/.system_generated/logs/chunks/<kind>/NNNN.jsonl newest slice
```

All four use the same schema. Read together they describe one conversation; read
individually, none of them does. `agchat` merges them by `step_index` (see
"Merging the logs" below).

```jsonc
{
  "step_index": 1,
  "source": "MODEL",              // MODEL | SYSTEM | USER_EXPLICIT | USER_IMPLICIT
  "type": "PLANNER_RESPONSE",
  "status": "DONE",               // DONE | RUNNING | ERROR | CLEARED
  "created_at": "2026-09-28T06:01:26Z",
  "content": "…",                 // prose for USER_INPUT / PLANNER_RESPONSE, tool output otherwise
  "thinking": "…",                // PLANNER_RESPONSE only
  "tool_calls": [ { "name": "run_command", "args": { … } } ],  // PLANNER_RESPONSE only
  "exit_code": 0,                 // RUN_COMMAND only
  "truncated_fields": […]         // present when the producer clipped something
}
```

### Merging the logs

The app writes a conversation to several places and each copy can be incomplete:

| file | what it holds | how it fails |
| --- | --- | --- |
| `transcript_full.jsonl` | the content log | **can lose the head** — one real 9,308-step session started at step 7,231 |
| `transcript.jsonl` | the same, capped | a subset |
| `chunks/**/NNNNNNNN.jsonl` | the newest slice | only the tail |
| `overview.txt` | the **full** step skeleton | its `content` is elided (`status: "CLEARED"`) except for the newest steps |

`parseTranscriptSet()` parses every source, then keeps the richest copy of each
`step_index` (most text/args/observation wins, ties broken by source priority:
`transcript-full` > `transcript`/`chunk-full` > `chunk`/`overview`). A cleared
skeleton entry therefore scores 0 and can never displace a real one.

The merge restores the early *timeline* and tool calls of a truncated session, but
not its prose: `coverageOf()` reports `steps` and `textSteps` separately, and
`stats` warns when the two disagree. The missing text is in
`conversations/<id>.pb`, which is encrypted and not readable offline.

### Event types

| kind | types | role | payload |
| --- | --- | --- | --- |
| human | `USER_INPUT` | user | `<USER_REQUEST>` body |
| model | `PLANNER_RESPONSE` | assistant | `content` (prose) + `thinking` + `tool_calls[]` |
| observation | `GENERIC`, `RUN_COMMAND`, `VIEW_FILE`, `LIST_DIRECTORY`, `GREP_SEARCH`, `SEARCH_WEB`, `READ_URL_CONTENT`, `CODE_ACTION`, `CHECKPOINT`, `INVOKE_SUBAGENT`, `ASK_QUESTION` | tool | `content` (output), `exit_code` |
| system | `SYSTEM_MESSAGE`, `CONVERSATION_HISTORY`, `EPHEMERAL_MESSAGE` | system | `content` |
| error | `ERROR_MESSAGE` | system | `error`, `error_code` |

### Request/result pairing

There is no tool-start event. `finalize()` walks the events in order, keeping a queue of
pending requests from the most recent `PLANNER_RESPONSE`, and assigns each observation
event to the next pending request. That yields, on the observation event:

- `toolName` — from the request (`run_command`, not the event type `RUN_COMMAND`)
- `argsText` / `argsSummary` — the request's arguments, for `--grep-scope args` and badges
- `toolMs` — `result.created_at - request.created_at`
- `toolCallId` — `step<request>:<result>`

A new `PLANNER_RESPONSE` or `USER_INPUT` clears any unanswered queue, so a lost result
cannot steal the next one.

### Traps

1. **`step_index`, not time, is the order.** Timestamps have second resolution and
   repeat.
2. **`content` is overloaded.** Tool output is parked in `observation` by the adapter so
   it can never be counted as prose.
3. **`status` is not success.** A `RUN_COMMAND` can be `DONE` with `exit_code: 1`; the
   adapter treats a non-zero exit code as a failure.
4. **Argument values are quoted strings of JSON** (`"CommandLine":"\"echo hi\""`) with
   PascalCase keys, so a naive `JSON.parse` of the argument map yields strings that still
   need unquoting.
5. **`USER_INPUT` is more than the request.** `<ADDITIONAL_METADATA>` and
   `<USER_SETTINGS_CHANGE>` blocks follow `<USER_REQUEST>`; only the request body is the
   human's words.
6. **`CONVERSATION_HISTORY` is a marker with no `content`.** Titles live elsewhere
   (`conversation_summaries.db`, `annotations/<id>.pbtxt`).
7. **`transcript_full.jsonl` is a superset of `transcript.jsonl`, but not of the
   conversation.** It can start part-way through (see "Merging the logs"), and the
   catalog can also reference conversations whose log is absent entirely — 207 of
   294 on the measured install. Check `head` in `sessions` or the coverage block in
   `stats` before quoting a total.
8. **`CLEARED` means the text was dropped.** The step still exists — type, timestamp
   and `tool_calls` survive — which is why a truncated conversation can still be
   read as a timeline.
9. **The `.pb` store is encrypted, the `.db` store is not.** `.pb` is the older
   generation (to ~2026-08-13) and needs a key that is not on disk; `.db` is the
   newer one and is plain SQLite with plain protobuf blobs. `sessions` shows `lock`
   when a conversation exists only in the former.

---

## Not these formats

- `<User>/workspaceStorage/<hash>/chatSessions/*.jsonl` — a chat *state* patch log
  (`{"kind":0,"v":{…}}` then deltas), used only for the history entry and the
  last-message timestamp. Rejected by `looksLike()` on purpose.
- `~/.gemini/<dir>/conversations/<id>.pb`, `*.db`, `annotations/*.pbtxt` — protobuf /
  SQLite / text-protobuf metadata, not event logs. Read only for catalog metadata.
