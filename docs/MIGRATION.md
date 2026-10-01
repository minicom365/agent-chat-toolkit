# Where a conversation belongs, and what happens when that is gone

Four questions came out of the recovery work, and three of them are really the
same question: *what decides which conversations you can see?* This page records
what was measured, so the answers are not re-derived by guesswork later.

## 1. Why two language-server tools can recover different amounts

Everything that talks to Antigravity talks to the same `language_server.exe`, so
a difference in results has to come from **what is asked**, not from the server
being different. Four things were measured, each of which silently loses
conversations on its own:

| cause | effect | measured |
| --- | --- | --- |
| the listing RPC | returns nothing at all | `GetAllCascadeTrajectories` with `{}` → **`{}`**, while 146 / 107 / 97 conversations sit on disk in the three instances |
| the instance flag | conversation reads as missing | `--app_data_dir` defaults to `antigravity-ide`, so an `antigravity` conversation answers `trajectory not found in any store` |
| the trajectory RPC | silent head-prefix cut | stores ≥ 64 MiB lose their tail: 12,864 of 27,561 steps (`docs/ANTIGRAVITY.md`) |
| the store itself | the payload is gone | `CLEARED` steps, below |

So a tool that enumerates through the list RPC finds nothing, and a tool that
trusts one `GetCascadeTrajectory` call under-reports every large conversation.
`agchat` enumerates the **filesystem** and pages
**`GetCascadeTrajectorySteps`**, which is why its numbers differ: 288 of 294
stores came back complete, and the 6 that did not are the zero-filled files that
hold no steps at all.

## 2. `CLEARED`: the content the app itself deleted

This is the part that cannot be patched, and it is worth being precise about why.

Every step carries a status. In the plaintext store the numbers map to the API's
enum names exactly (verified on a 6,653-step conversation where both agree row for
row):

| store value | API name |
| --- | --- |
| `3` | `CORTEX_STEP_STATUS_DONE` |
| `5` | `CORTEX_STEP_STATUS_CLEARED` |
| `6` | `CORTEX_STEP_STATUS_CANCELED` |

A cleared step keeps its `type`, `status` and `metadata` and loses everything
else. Measured per step, not inferred:

```
CLEARED steps      5,760    with a payload: 0
non-CLEARED steps    893    with a payload: 424
```

The stub is on **disk**, in the `step_payload` blob, not merely dropped from the
response — so this is not a read limit, a key problem or a truncation. The
extreme case measured was a 27,561-step conversation with **27,560 steps cleared**
and one surviving: its `USER_INPUT` step 0 still has a timestamp and an
execution id, and no text.

Two consequences worth stating plainly:

- **Some conversations cannot be recovered by anything.** No key, protocol or
  reader brings that text back, because it is not on disk in any form.
- **What the app shows and what this tool exports are limited by the same
  eviction.** `agchat recover` gets everything that still exists, including the
  cleared skeletons, so an export is a complete *record* even when it is a thin
  *transcript*.

### What could still be patched, and what it rests on

The 64 MiB ceiling is a **reader** limit, so a conversation can be re-homed into
reader that has no ceiling. The plaintext `.db` generation is exactly such a
reader, and the wire formats line up, which was checked rather than assumed:

- `application/proto` works. Posting the same request with
  `Content-Type: application/proto` instead of `application/json` returns
  HTTP 200 and **11,212 bytes instead of 17,232** for a 7-step conversation, with
  7 top-level entries — the same step count.
- The step bytes are already the exact shape the store keeps. A step begins
  `08 <type> 20 <status> 2a <metadata…>` on the wire, and the `.db`'s
  `step_payload` blob for the same kind of step is the identical
  `08 … 20 … 2a …` framing.

So a conversion would be: read the steps as protobuf, write them into a `.db`
with the same schema (`steps`, `trajectory_meta`, `gen_metadata`,
`executor_metadata`, `parent_references`, `trajectory_metadata_blob`), and
register it. Nothing has to be re-encoded field by field.

Two things are still unknown and are the reason this is written down rather than
shipped: whether the app prefers `.db` when both stores exist for one
conversation, and whether it rebuilds the sidebar from the registry. Neither can
be settled without a sandbox profile and a running build, and getting it wrong
in the live profile is the kind of mistake this project refuses to make.

## 3. Moving an Antigravity conversation between instances or projects

Antigravity keeps an explicit registry, which is what makes this well-defined
rather than a file-shuffling guess:

```
~/.gemini/<instance>/conversations/<id>.pb | .db     the store
~/.gemini/<instance>/conversation_summaries.db       the registry
```

The registry answers both halves of the question:

| column | meaning |
| --- | --- |
| `conversation_id` | primary key |
| `app_data_dir` | which instance owns the store |
| `workspace_uris` | JSON array of `file:///c%3A/…` URIs = the project space |
| `project_id` | project-space UUID, `''` = unassigned |
| `step_count` | what the list shows before the conversation is opened |

So "move it to the IDE build" and "file it under this project" are one store copy
plus one row:

```
agchat migrate --session <id> --from antigravity --to antigravity-ide
agchat migrate --session <id> --from antigravity --to antigravity-ide \
               --workspace c:\Users\me\PROJECT\x --project-id <uuid> --apply
```

Safety, because this writes into a live profile:

- dry run unless `--apply`; the store is copied, never moved, never deleted;
- the registry database is backed up before the first row is written;
- an instance with no registry is reported, not silently skipped;
- `--from` also scopes the lookup, because the same conversation id normally
  exists in **every** instance on the machine.

One step is deliberately left out: the sidebar list is also cached in
`state.vscdb['antigravityUnifiedStateSync.trajectorySummaries']`. The registry is
the durable record and the cache is expected to be rebuilt from it, but that has
not been confirmed against a running build, so the cache is not rewritten.

## 4. Orphaned VS Code workspaces

VS Code keys a storage folder by a hash of the workspace URI, so moving or
deleting a folder leaves `<User>/workspaceStorage/<hash>/` behind — still holding
`chatSessions/*.jsonl` that no workspace points at any more. The editor cannot
show them; nothing is corrupt.

```
$ agchat orphans
storages       6 of 416 hold conversations but have no workspace
conversations  10
on disk        4.3MB
```

Storages with no conversation files are skipped, so the report is only what is
actually stranded. `agchat sessions --orphaned-workspace` gives the same set as a
conversation list, and each row can be brought back with the existing `move`:

```
agchat move --session <id> --data-dir <user-data root> --to <live storage hash> --apply
```

Note the two flags are different things: `--orphaned-workspace` means the folder
behind the storage is gone, while `--orphans-only` (which predates it) means the
conversation is missing from the app's own index.
