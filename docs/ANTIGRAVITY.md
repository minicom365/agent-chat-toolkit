# Antigravity: what is readable, and what needs the language server

Antigravity looks opaque at first: opaque binary files, a language server that
"owns" the data, and tools that conclude you must go through it. This document
records what is actually on disk, what this tool reads, and where the real
limitation is.

**Short version: the conversation *text* is plaintext JSONL, but no single file
holds a whole long conversation, and the one store that claims to is genuinely
encrypted.** The catalog is plain SQLite and the sidebar index is base64-wrapped
protobuf. `conversations/<id>.pb` is real ciphertext and cannot be read offline.

Three separate things have to be handled, and an earlier revision of this
document got two of them wrong:

1. **`transcript_full.jsonl` can lose the head of a long session.** Measured on a
   real 9,308-step conversation, the log started at step **7,231** — 78% of the
   conversation was missing from the only file that looked authoritative.
2. **`overview.txt` is the recovery source.** It holds the full step skeleton
   (types, timestamps, tool calls) for the steps the transcript dropped.
3. **`conversations/<id>.pb` is encrypted**, not merely schema-less. Its entropy
   is 8.000 bits/byte across the whole file, it has no compression or container
   magic, and no key on the machine decrypts it.

---

## The stores

```
~/.gemini/<instance>/                      conversation content + catalog
    brain/<id>/.system_generated/logs/overview.txt            plaintext JSONL skeleton
    brain/<id>/.system_generated/logs/transcript_full.jsonl   plaintext JSONL (may lose the head)
    brain/<id>/.system_generated/logs/transcript.jsonl        plaintext JSONL (capped)
    brain/<id>/.system_generated/logs/chunks/<kind>/NNNNNNNN.jsonl  newest slice
    brain/<id>/scratch/*, *.md                                artifacts
    conversation_summaries.db                                 plaintext SQLite
    conversations/<id>.pb | <id>.db                           encrypted | SQLite
    annotations/<id>.pbtxt                                    plaintext text-protobuf

<appProfile>/User/globalStorage/state.vscdb  what the sidebar shows
    ItemTable['antigravityUnifiedStateSync.trajectorySummaries']  base64 protobuf
```

| store | encoding | readable without the language server? |
| --- | --- | --- |
| `overview.txt` | UTF-8 JSONL (same schema as the transcript) | **yes** — full skeleton, text elided |
| `transcript.jsonl` / `transcript_full.jsonl` | UTF-8 JSONL | **yes** — but may start part-way through |
| `chunks/…/NNNNNNNN.jsonl` | UTF-8 JSONL | **yes** — always a subset of the tail |
| `conversation_summaries.db` | SQLite, plaintext columns | **yes** |
| `annotations/<id>.pbtxt` | text protobuf | **yes** |
| `state.vscdb` → `trajectorySummaries` | base64 of a protobuf message | **yes** (see below) |
| `conversations/<id>.pb` | **AES ciphertext** | **no** |
| `conversations/<id>.db` | SQLite, protobuf-encoded blobs | no (schema problem) |

## The logs overlap: merge, do not pick one

`agchat` treats every log in the folder as one source and merges them by
`step_index`, keeping the richest copy of each step. For a truncated
conversation that is the difference between 2,077 visible events and 4,750:

```
logs merged      transcript-full, chunk-full, transcript, chunk, overview
steps (merged)   4,750 · step 0…9,307
steps with text  1,342 (from step 6,380)
  ⚠ steps 0…6,379 are skeleton only (the app cleared their text; the full copy is
    in the encrypted <id>.pb store).
```

The early steps come back as *skeleton*: you get the type, timestamp and — for
the 248 steps that recorded a `tool_calls` field — which tool was invoked, but
not the prose. `agchat sessions` marks these conversations `skel` in the `head`
column, `lost` when no log covers the head at all, and `full` when the content
transcript is complete.

`overview.txt` uses the *same* JSONL schema as the transcript. A step whose text
was dropped carries `"status": "CLEARED"` and no `content`; a merged parse can
therefore never let a cleared skeleton entry displace a real one.

## What "encrypted" actually looks like

A value that starts with `CrgFCiQx…` and contains A–Z, a–z, 0–9, `+`, `/`, `=` is
**base64**, not ciphertext — that is the case for `trajectorySummaries`. Base64 is
one `Buffer.from(x, 'base64')` away from the protobuf frame underneath it, and
`src/protobuf.js` walks that frame to read the sidebar index:

```
trajectorySummaries  repeated field 1:
  entry    { 1: conversationId, 2: { 1: base64(summary) } }
  summary  { 1: title, 2: stepCount, 3: created, 4: trajectoryId,
             9: { 1: workspaceUri }, 10: lastModified, 17: { … } }
```

`conversations/<id>.pb` is the opposite case and must not be confused with it:

| measurement | value | conclusion |
| --- | --- | --- |
| entropy (head / middle / tail 1 MB) | 8.000 / 8.000 / 8.000 bits/byte | ciphertext, no plaintext header |
| container or compression magic | none (gzip, zlib, zstd, lz4, sqlite all absent) | no framing to unwrap |
| `walk()` of the first 1 MB | 1 field, then garbage | not protobuf at the top level |
| size modulo 16 / 1024 / 4096 | 5 / 261 / 1,285 | no padded block cipher; stream cipher or length-prefixed |
| repeated 16-byte blocks in 4 MB | 0 | no ECB structure |

The upstream tool `arashz/antigravity_decryptor` documents **AES-128-CTR with the
nonce in the first 16 bytes**, and takes its key from the macOS Keychain
(`Antigravity Safe Storage` / `Antigravity Key`). On Windows it requires the key
to be passed in manually, which is the tell: the key is not derivable from the
filesystem.

Checked on a real Windows install, all negative:

- The Electron/Chromium master key in `Local State` (`os_crypt.encrypted_key`,
  unprotected with DPAPI) is **correct** — it authenticates the `v10` secrets in
  `state.vscdb` — but it does **not** decrypt any `.pb` (tried as AES-128/192/256
  CTR and CBC, and GCM with the tag at either end, across nonce lengths 12/16 and
  header skips 0/1/2/4/8).
- No DPAPI-wrapped blob exists anywhere in the profile (28,168 files scanned), so
  the key is not stored via Electron `safeStorage` either.
- The encryption scheme has changed across Antigravity releases, so a decryption
  routine written for one version does not carry over.

**Practical consequence:** the missing text of a truncated conversation is not
recoverable offline. The two routes that do work are the app's own reader (open
the conversation, or drive the bundled language server) and the `overview.txt`
skeleton that `agchat` already merges. Everything this tool reports from a
conversation with a `skel`/`lost` head is a **lower bound** on that conversation,
and `agchat stats` says so in its warnings rather than presenting a partial total
as the whole story.

## Where the schema problem still applies

`conversations/<id>.db` (older builds) holds the conversation in an unpublished
protobuf schema inside SQLite blobs. Reading it without the language server would
require reverse-engineering that schema, and a schema you have guessed is a schema
you will silently misread.

The `.pb`/`.db` file is therefore only consulted to report which store a
conversation uses, because that correlates with visibility:

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
- **It does not read `.pb` conversation bodies.** They are encrypted, not just
  schema-less; see the measurements above.
- **It does not use the language server.** That is a deliberate choice: it needs a
  running IDE, a live (often OAuth-guarded) session, and it reads only what the app
  currently knows about. It is, however, the *only* route to the text of a
  truncated conversation, so a tool that needs those bytes should go through the
  app's reader rather than the filesystem.

## Diagnosing a "lost" conversation

1. `agchat hosts` — confirm the instance and its counts.
2. `agchat sessions --host antigravity --recoverable` — list what is on disk but
   unlisted. The `head` column also shows whether any conversation lost the head
   of its content log (`skel` = recoverable skeleton, `lost` = gone).
3. `agchat stats -s <id>` — read the coverage block. "4,750 steps, 1,342 with
   text" is the honest picture; the bare step count is not.
4. If the conversation is missing entirely, look for the instance that still has it
   (`--instance backup`, `--instance ide`): an update can leave the content in a
   previous instance directory.
5. `agchat show -s <id> -l 4 --out recovered.md` — get the content out. Recall
   that steps before `firstTextStep` come back as a skeleton.
6. Before doing anything destructive to `state.vscdb`, copy the whole
   `<appProfile>/User/globalStorage/` directory.
