# Antigravity: what is readable, and what needs the language server

Antigravity looks opaque at first: opaque binary files, a language server that
"owns" the data, and tools that conclude you must go through it. This document
records what is actually on disk, what this tool reads, and where the real
limitation is.

**Short version: nothing relevant is encrypted.** The conversation content is
plaintext JSONL, the catalog is plain SQLite, and the sidebar index is
base64-wrapped protobuf. Only the per-conversation protobuf files have no public
schema — and their content is available elsewhere.

---

## The three stores

```
~/.gemini/<instance>/                      conversation content + catalog
    brain/<id>/.system_generated/logs/transcript_full.jsonl   plaintext JSONL
    brain/<id>/.system_generated/logs/transcript.jsonl        plaintext JSONL (truncated)
    brain/<id>/scratch/*, *.md                                artifacts
    conversation_summaries.db                                 plaintext SQLite
    conversations/<id>.pb | <id>.db                           protobuf | SQLite
    annotations/<id>.pbtxt                                    plaintext text-protobuf

<appProfile>/User/globalStorage/state.vscdb  what the sidebar shows
    ItemTable['antigravityUnifiedStateSync.trajectorySummaries']  base64 protobuf
```

| store | encoding | readable without the language server? |
| --- | --- | --- |
| `transcript.jsonl` / `transcript_full.jsonl` | UTF-8 JSONL | **yes** — this is the conversation |
| `conversation_summaries.db` | SQLite, plaintext columns | **yes** |
| `annotations/<id>.pbtxt` | text protobuf | **yes** |
| `state.vscdb` → `trajectorySummaries` | base64 of a protobuf message | **yes** (see below) |
| `conversations/<id>.pb` | protobuf, undocumented schema | no — the language server is the app's own reader |
| `conversations/<id>.db` | SQLite, protobuf-encoded blobs | no (same schema problem) |

## "Encrypted" is usually base64

A value that starts with `CrgFCiQx…` and contains A–Z, a–z, 0–9, `+`, `/`, `=` is
**base64**, not ciphertext. Base64 is one `Buffer.from(x, 'base64')` away from the
protobuf frame underneath it.

Protobuf's wire format is self-describing enough to walk without a `.proto` file:
every field carries its number and wire type, so a generic reader recovers
varints, nested messages and length-delimited strings. That is exactly what
`src/protobuf.js` does, and it is how the sidebar index is read here:

```
trajectorySummaries  repeated field 1:
  entry    { 1: conversationId, 2: { 1: base64(summary) } }
  summary  { 1: title, 2: stepCount, 3: created, 4: trajectoryId,
             9: { 1: workspaceUri }, 10: lastModified, 17: { … } }
```

Field numbers were derived by reading real values. The reader is deliberately
schema-light: it identifies timestamps by *shape* (`{1: seconds, 2: nanos}`),
UTF-8 by *decodability*, and identifiers by *pattern*, and reports nothing rather
than guessing when a value does not look right.

## Where encryption would actually matter — and why it does not here

`conversations/<id>.pb` (current) and `<id>.db` (older) hold the same conversation
again, in a protobuf schema Google has not published. Reading those without the
language server would require reverse-engineering that schema, and a schema you
have guessed is a schema you will silently misread.

It is unnecessary, because the same content exists in `transcript_full.jsonl`,
which is what this tool analyses. The `.pb`/`.db` file is only consulted to report
which store a conversation uses, because that correlates with visibility:

| store | listed in the sidebar index | typical |
| --- | --- | --- |
| `.pb` | yes | current conversations |
| `.db` | **no** | conversations written by an older build |

## Instances

Antigravity keeps one directory per installation/profile under `~/.gemini/`:

| instance | meaning |
| --- | --- |
| `antigravity` | the current desktop app |
| `antigravity-ide` | the IDE build (separate profile, separate conversations) |
| `antigravity-backup` | a snapshot of an older profile |
| `antigravity-history` | a third-party extension's cache (`cache.json`) |

Instances are discovered generically as `~/.gemini/*antigravity*`, so a future
rename does not need a code change. Each is catalogued separately — conversations
in a backup instance are not visible to the live app and are not indexed by it.

## Visibility: `idx` in `agchat sessions`

```
 #  host         instance            updated              idx  store  title
--  -----------  ------------------  -------------------  ---  -----  --------------------------------
 1  antigravity  antigravity         2026-01-05 18:10:00  yes  pb     Sandbox antigravity conversation
 2  antigravity  antigravity         2026-01-04 18:04:00  no   db     Sandbox legacy conversation
 3  antigravity  antigravity-ide     2026-01-03 18:10:00  yes  pb     Sandbox IDE conversation
 4  antigravity  antigravity-backup  2026-01-02 18:04:00  ?    pb     Sandbox backup conversation
```

- `yes` — the app's own index lists it.
- `no` — it is on disk but the app's index does not list it. If a transcript
  exists, `recoverable` is true: the content is fully readable by this tool even
  though the UI will not show it.
- `?` — no app profile indexes this instance (a backup snapshot), so visibility is
  genuinely unknown. The tool reports `?` rather than guessing.

An app profile is matched to an instance **by identifier overlap**, and IDE builds
are only matched to IDE profiles. A profile that indexes nothing in an instance is
not claimed for it.

```bash
agchat sessions --host antigravity --not-indexed   # on disk, not in the sidebar index
agchat sessions --host antigravity --recoverable   # ... and readable by this tool
agchat sessions --instance backup                  # one instance only
agchat show -s <id> -l 2 > recovered.md            # export the content
```

## What this tool does not do

- **It never writes to an Antigravity store.** Repairing `trajectorySummaries`
  would mean re-encoding protobuf into a live global state, and a mistake there
  loses every sidebar entry — a worse outcome than a missing conversation. The
  read-only report plus `show`/`export` is the safe path.
- **It does not read `.pb`/`.db` conversation bodies**, for the schema reason above.
- **It does not use the language server.** That is a deliberate choice: it needs a
  running IDE, a live (often OAuth-guarded) session, and it reads only what the app
  currently knows about — exactly the conversations that are *not* missing.

## Diagnosing a "lost" conversation

1. `agchat hosts` — confirm the instance and its counts.
2. `agchat sessions --host antigravity --recoverable` — list what is on disk but
   unlisted.
3. If the conversation is missing entirely, look for the instance that still has it
   (`--instance backup`, `--instance ide`): an update can leave the content in a
   previous instance directory.
4. `agchat show -s <id> -l 4 --out recovered.md` — get the content out.
5. Before doing anything destructive to `state.vscdb`, copy the whole
   `<appProfile>/User/globalStorage/` directory.
