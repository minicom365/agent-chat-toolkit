# Host storage layouts

Where each host keeps its conversations, what the files contain, and which pitfalls
make naive parsing wrong. Everything here was derived by reading real data; it is a
descriptive reference, not an official specification.

---

## VS Code (Copilot Chat)
Root: the VS Code user-data directory — `%APPDATA%\<Product>\User` on Windows,
`~/Library/Application Support/<Product>/User` on macOS,
`$XDG_CONFIG_HOME/<Product>/User` on Linux.

```
<User>/workspaceStorage/<hash>/
    workspace.json                              { "folder": "file:///…" } or { "workspace": "…" }
    state.vscdb                                 SQLite: ItemTable(key, value)
    state.vscdb.backup                          VS Code restores from this when present
    chatSessions/<sessionId>.jsonl              chat state patch log   (what the UI reads)
    GitHub.copilot-chat/transcripts/<sid>.jsonl agent event log        (what the agent did)
    chatEditingSessions/<sessionId>/…           edit history
```

### The index

`state.vscdb`, table `ItemTable`, key `chat.ChatSessionStore.index` holds JSON:

```jsonc
{
  "version": 1,
  "entries": {
    "<sessionId>": {
      "sessionId": "…",
      "title": "Refactoring the media pipeline",
      "lastMessageDate": 1787854657742,
      "timing": { "created": 1787854657742, "lastRequestStarted": …, "lastRequestEnded": … },
      "initialLocation": "panel",
      "hasPendingEdits": false,
      "isEmpty": false,
      "isExternal": false,
      "lastResponseState": 1,
      "permissionLevel": "default",
      "stats": { "fileCount": 32, "added": 307, "removed": 27575 }
    }
  }
}
```

The history panel shows exactly this list, **for the current window's storage folder
only**. That is the source of both failure modes below.

### Pitfalls

1. **One workspace, several storage folders.** `workspace.json` pins a storage folder
   to a workspace, but the same folder path can be recorded by more than one hash
   (folder open vs `.code-workspace` file, re-opened after an update, …). A
   conversation saved under one hash is invisible in the window using another.
2. **Orphaned conversations.** The `chatSessions/*.jsonl` and
   `transcripts/*.jsonl` files can outlive their index entry, and VS Code only
   rebuilds an entry when it is opened from the UI. Those sessions are invisible.
   `sessions` lists them and marks them `orphan`; `move` repairs them.
3. **`state.vscdb.backup`.** VS Code may restore the index from this sibling file, so a
   repair that updates only `state.vscdb` can silently revert. `move` updates both.
4. **Never write while the editor is running.** The in-memory index is flushed over
   your change on the next write.
5. **`workspace.json` URIs are percent-encoded** (`file:///c%3A/Users/…`), so they must
   be decoded before they are shown as a path.

### Transcript vs chat state

| file | format | use |
| --- | --- | --- |
| `GitHub.copilot-chat/transcripts/<id>.jsonl` | event log (see [TRANSCRIPT-FORMAT.md](TRANSCRIPT-FORMAT.md)) | statistics, search, timing |
| `chatSessions/<id>.jsonl` | patch/operation log (`{"kind":0,"v":{…}}` then deltas) | the history panel entry, titles |

Only the first is parsed for analysis; the second is used for the index entry and the
last-message timestamp.

---

## Antigravity

Root: `~/.gemini/<instance>/`. Every `*antigravity*` directory is discovered as a
separate **instance** — current app, IDE build, older snapshot, and the history
extension's cache. Each is catalogued independently; see
[ANTIGRAVITY.md](ANTIGRAVITY.md) for the deep dive, including what is plaintext,
what is protobuf, and why the language server is not needed.

```
~/.gemini/<instance>/
    conversation_summaries.db                  SQLite: the authoritative catalog
    conversations/<id>.pb | <id>.db             protobuf | SQLite per-conversation store
    annotations/<id>.pbtxt                      title, last_user_view_time
    cache.json                                  (history extension only) cached catalog
    brain/<conversationId>/
        .system_generated/logs/transcript_full.jsonl   step log (untruncated)  <- preferred
        .system_generated/logs/transcript.jsonl        step log (truncated)
        .system_generated/logs/chunks/…                chunked copies
        .system_generated/steps/<n>                    per-step blobs
        .system_generated/messages/<id>.json           queued messages
        scratch/*                                      scratch code written by the agent
        *.md                                           markdown artifacts

<appProfile>/User/globalStorage/state.vscdb         what the sidebar shows
    ItemTable['antigravityUnifiedStateSync.trajectorySummaries']   base64 protobuf
```

Instance directories seen on a real machine: `antigravity`, `antigravity-ide`,
`antigravity-backup`, `antigravity-history`, `antigravity-browser-profile`.

### The catalog

`conversation_summaries.db`, table `conversation_summaries`:

| column | meaning |
| --- | --- |
| `conversation_id` | session id (matches the `brain/<id>` folder) |
| `title` | display title (often empty) |
| `preview` | last user message preview — used as a title fallback |
| `step_count` | number of steps in the log |
| `last_modified_time` | ISO-ish text timestamp, e.g. `2026-05-22 07:14:38.7154497+00:00` |
| `workspace_uris` | JSON array of `file:///…` URIs |
| `status` | e.g. `CASCADE_RUN_STATUS_IDLE` |
| `parent_conversation_id` | set for sub-agent conversations |
| `nesting_depth` | sub-agent depth |
| `app_data_dir` | which `~/.gemini/<dir>` this row belongs to |

This single table is the whole catalog: title, project, timestamp and step count for
every conversation, in one read.

### The step log

See [TRANSCRIPT-FORMAT.md](TRANSCRIPT-FORMAT.md#antigravity-step-log). The essential
difference from VS Code: **there is no separate tool-start event.** A tool *request*
lives in `PLANNER_RESPONSE.tool_calls[]`, and the *result* arrives later as its own
event whose `type` names the tool kind (`RUN_COMMAND`, `VIEW_FILE`, `GENERIC`, …). The
adapter pairs them in step order, which is what makes tool names, tool runtime and
failure rates available at all.

### Pitfalls

1. **Content and visibility live in different places.** A complete transcript can
exist while the sidebar index does not list it. `agchat sessions` reports this as
`idx = no`, and `--recoverable` narrows to the ones this tool can still read.
2. **`conversations/<id>.db` is the old store format** and `conversations/<id>.pb`
the current one; the old format correlates strongly with being unlisted.
3. **`CONVERSATION_HISTORY` events carry no `content`** — they are markers, not titles.
   Titles come from `conversation_summaries.db`, the sidebar index, or
   `annotations/<id>.pbtxt`.
2. **`title` is frequently empty** in the catalog; fall back to `preview`, then to the
   annotation file, then to `(untitled)`.
3. **Only a fraction of `brain/<id>` folders have a transcript.** Empty or crashed
   sessions have none; the catalog can reference a conversation whose log is missing.
4. **`transcript_full.jsonl` is a superset** of `transcript.jsonl`; prefer it when both
   exist, and report which variant was used.
5. **Timestamps are second-resolution UTC** (`2026-09-28T06:01:26Z`), so several events
   share a timestamp. Order by `step_index`, never by time alone.
6. **`content` is overloaded.** For `USER_INPUT` and `PLANNER_RESPONSE` it is prose; for
   every other `MODEL` type it is tool output. Tool output is parked in
   `observation`, never in `text`, so it cannot pollute prose statistics.
7. **`USER_INPUT` wraps the real request** in `<USER_REQUEST>…</USER_REQUEST>`, followed
   by `<ADDITIONAL_METADATA>` and `<USER_SETTINGS_CHANGE>` blocks that are not the
   user's words.
8. **Tool arguments are quoted strings with embedded JSON** (`"CommandLine":"\"echo
   hi\""`) and use PascalCase keys (`TargetFile`, `AbsolutePath`, `CommandLine`,
   `DirectoryPath`), unlike every other host's `snake_case`.
9. **`exit_code` decides success** for `RUN_COMMAND`; `status` alone is `DONE` even when
   the command failed.
