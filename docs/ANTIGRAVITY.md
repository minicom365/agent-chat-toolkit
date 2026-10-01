# Antigravity: what is readable, and what needs the language server

Antigravity looks opaque at first: opaque binary files, a language server that
"owns" the data, and tools that conclude you must go through it. This document
records what is actually on disk, what this tool reads, and where the real
limitation is.

**Short version: the conversation *text* is plaintext JSONL, but no single file
holds a whole long conversation, and the store that does may be encrypted.** The
catalog is plain SQLite and the sidebar index is base64-wrapped protobuf. Of the
two per-conversation stores, the **older** `<id>.pb` is real ciphertext no
offline key opens, while the **newer** `<id>.db` is plain SQLite — the direction
of that change is the opposite of what a first look suggests.

Four separate things have to be handled, and earlier revisions of this document
got two of them wrong:

1. **`transcript_full.jsonl` can lose the head of a long session.** Measured on a
   real 9,308-step conversation, the log started at step **7,231** — 78% of the
   conversation was missing from the only file that looked authoritative.
2. **`overview.txt` is the recovery source.** It holds the full step skeleton
   (types, timestamps, tool calls) for the steps the transcript dropped.
3. **`conversations/<id>.pb` is encrypted**, not merely schema-less. Its entropy
   is 8.000 bits/byte across the whole file, it has no compression or container
   magic, and no key on the machine decrypts it.
4. **`conversations/<id>.db` is plaintext.** It is the *newer* generation (the
   app stopped encrypting around 2026-08-14), and 207 older `.pb` conversations
   have no log at all, so they are locked in the encrypted store for good.

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
| `conversations/<id>.db` | SQLite; blob columns are **plain protobuf** | **yes** — walk the wire format |

## Two store generations, and the newer one is the readable one

This is the detail most likely to be got backwards, so it is worth stating with
the measurement that settles it. Across one full install (350 stores):

| generation | file | date range | head 64 KB entropy | verdict |
| --- | --- | --- | --- | --- |
| older | `<id>.pb` | 2025-11 … 2026-08-13 | 8.00 (all 294) | **encrypted** |
| newer | `<id>.db` | 2026-08-03 … onwards | 3.1 – 5.1 (all 56) | **plaintext** |

The cutover was around **2026-08-14**, and it went *from* encryption *to*
plaintext. No conversation appears in both formats, so old conversations stay
`.pb` for good.

`.db` blobs are ordinary protobuf and need no key at all — a schema-less walk
recovers real text. From a 3.9 MB store, 727,068 characters came back, including
tool arguments, file paths, code and Korean prose:

```
AbsolutePath  C:\Users\ms338\.gemini\antigravity\brain\0e3fc1fe…\scratch\repo\.agents\skills\video\SKILL.md
CommandLine   current = "c:\Users\ms338\Nextcloud2\전남대\3학년\2학기\ai 특강 실습\Obsidian-template-main"
```

Reading `.db` is nevertheless **not** worth doing for its own sake: for 50 of the
56 stores the merged logs already cover exactly the same steps (`store steps ==
log max + 1`), and in 6 cases the store holds only two steps more. It is a
useful fallback if the `brain/` logs are ever lost, not a source of new content.

What the generation split *does* decide is whether a conversation can be read at
all. Measured over all 350 conversations:

| | conversations | no log at all | recoverable |
| --- | --- | --- | --- |
| `.pb` | 294 | **207** | only where a log survives |
| `.db` | 56 | 0 | always |

**207 conversations exist only as encrypted `.pb`.** For those, no transcript,
no overview, and no offline key — `agchat sessions` marks them `lock` in the
`head` column, and `agchat recover` exports them through the language server.

Six further `.pb` files (3 conversations, duplicated across two instances) are
27–48 MB of **all zero bytes**: allocated but never written, i.e. content that
was lost rather than encrypted.

## The logs overlap: merge, do not pick one

`agchat` treats every log in the folder as one source and merges them by
`step_index`, keeping the richest copy of each step. For a truncated
conversation that is the difference between 2,077 visible events and 4,750:

```
logs merged      transcript-full, chunk-full, transcript, chunk, overview
steps (merged)   4,750 · step 0…9,307
steps with text  1,342 (from step 6,380)
  ⚠ steps 0…6,379 have no text in the log, and the store does not hold it
    either: they are marked CORTEX_STEP_STATUS_CLEARED (payload deleted).
```

The early steps come back as *skeleton*: you get the type, timestamp and — for
the 248 steps that recorded a `tool_calls` field — which tool was invoked, but
not the prose. **The encrypted store is not a second copy**: measured across all
100 `.pb` conversations in one instance, 185,999 of 259,414 steps (71.7%) are
`CLEARED`, and not one of them carries a payload in the store either.

The app's own log files *are* a second copy, but a shallow one. Across the 40
conversations that have cleared steps, only **2,131 of 185,999 cleared steps
(1.1%)** still have their text in `transcript_full.jsonl` or `overview.txt` —
almost all of them in a single conversation whose log reached back further than
its store did. Retention windows differ per subsystem; the store is not the
archive.

The relationship is visible in the profile as a whole, and it is monotonic —
bigger conversations are cleared harder:

| store size | conversations | steps CLEARED |
| --- | --- | --- |
| 0–1 MB | 15 | 0% |
| 1–5 MB | 19 | 6% |
| 5–15 MB | 18 | 10% |
| 15–30 MB | 29 | 58% |
| 30–60 MB | 12 | 90% |
| 60 MB+ | 2 | 95% |

That is also why the 64 MiB reader ceiling and the eviction belong to the same
story: eviction keeps a store near the ceiling, and what still exceeds it is the
part that cannot be reached without paging.

`agchat sessions` marks these conversations in the `head` column:
`full` when the content transcript is complete, `skel` when the head survives
only as a cleared skeleton, `lost` when no log covers the head at all, and
`lock` when the content exists *only* inside the encrypted `.pb` store.

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

**Practical consequence:** the key is not derivable offline, but it does not
need to be — the bundled language server holds it. `agchat recover` exports the
full trajectory through that server (see "Exporting a `lock`ed conversation").
The `overview.txt` merge remains the only offline source, and a conversation
with a `skel`/`lost` head reported by `stats` is still a **lower bound** until
`recover` is run.

### A memory scan for the key, and why its negative is not a result

The last resort was to look for the key in the language server's own memory: dump
the process, then treat every byte offset as a candidate 16-byte AES key and test
it against a `.pb` whose plaintext is known. That scan ran to completion —
**320,602,097 windows, every offset, 2,403 s** — and reported no hit. **The
negative does not hold**, and the reason is worth recording.

A positive control (plant a known key in a decoy buffer, at an unaligned offset,
and check the scanner finds it) separates the two halves of the tool:

| control | plaintext shape | result |
| --- | --- | --- |
| A | six short protobuf fields (64 B) | **found** ✅ |
| B | one long length-delimited field (66 B) | **missed** ❌ |

So the AES rounds, the CTR counter handling and the oracle search are all
correct — control A exercises every one of them. The defect is the **prefilter**:
it demands at least three protobuf fields inside the first 64 bytes of plaintext,
and a container whose first field wraps the whole payload can never satisfy that.
The true key is then skipped silently, without any error.

Whether the real `.pb` has that shape is unknown — the container layout cannot be
read without the key — so the honest statement is: *the key was not found as a
16-byte window in memory, if the container begins with three short fields.* That
condition is unverified, which makes the scan inconclusive rather than negative.

A conclusive scan is possible but must be built differently: with **16 bytes of
known plaintext**, a candidate costs one AES block instead of a full decrypt, so
the check becomes sound *and* fast (one block per offset, ~40 min at the observed
rate). Without known plaintext a sound filter has to accept every prefix that
cannot be disproved, which inflates the candidate set from 320 million to tens of
millions of full 100 KB decrypts — days, not minutes.

None of this blocks recovery: the key would decrypt the same bytes the API
already serves, and `GetCascadeTrajectorySteps` returns every step the store
still holds.

## Exporting a `lock`ed conversation

The key is not derivable offline, but the bundled language server holds it and
will decrypt any `.pb` it can load. `agchat` drives that server directly, so a
conversation that is unreadable in the app UI can still be exported in full:

```
$ agchat recover --session 44166d34
recovering 44166d34… from antigravity via language_server.exe
wrote C:\...\44166d34-….json (9308 steps, 56.9 MB)
```

What this does, in order:

1. Launches the shipped `language_server` binary standalone
   (`-standalone -persistent_mode -override_ide_name=antigravity
   --app_data_dir <instance>`), with stdin closed so it never blocks on the
   OAuth prompt — local trajectory reads need no sign-in.
2. Waits for the `listening on random port at N for HTTP` line. **That line is
   the plain-HTTP port; the line that precedes it is the `HTTPS (gRPC)` port and
   must not be picked.**
3. Pages `GetCascadeTrajectorySteps` from `stepOffset: 0` until a page returns no
   steps, then writes the merged JSON trajectory.

Verified on a real 9,308-step conversation whose `transcript_full.jsonl` had
lost 78% of its head: the endpoint returned **all 9,308 steps** (56.9 MB) in
2.5 s, matching the catalog's `step_count` exactly.

### The 64 MiB ceiling, and why the steps endpoint is the one to call

`GetCascadeTrajectory` and `GetCascadeTrajectorySteps` do **not** have the same
reach. Measured across every store on a real profile (288 readable stores):

| store size | stores | `GetCascadeTrajectory` |
| --- | --- | --- |
| under 64 MiB (max seen 63.7 MB) | 282 | returns every step |
| 64 MiB and over (69.4 – 79.3 MB) | 6 | stops early, always a **head prefix** |

The split is exact — no store was misclassified — and the cutoff sits between
63.7 MB and 69.4 MB, bracketing the ubiquitous 64 MiB (67,108,864 B) default.
Two of those conversations came back as 4,744 of 5,043 steps and 12,864 of
27,561 steps.

It is a limit in the reader, not a cap on the response:

- The response is **complete, parseable JSON** that ends with
  `"status":"CASCADE_RUN_STATUS_IDLE","numTotalSteps":27561` — the server
  discloses the true total while returning only part of it, so nothing about
  the reply looks wrong.
- Repeating the call returns a **byte-identical** body (129,800,304 B), and
  warming the process only makes it faster (8,915 ms → 3,515 ms), so it is not
  a deadline and not a race.
- A 113 MB response came back **complete** for a store under the threshold, so
  it is not a response-size limit either. The threshold follows the **store
  file size**.
- The cut does not land on a chunk boundary — the `brain/…/logs/chunks/`
  directories are empty for those conversations.

It applies to the **encrypted `.pb` generation only**. The same measurement on
newer plaintext `.db` stores returns everything at any size (90.9 MB → 17,738 of
17,738 steps; 79.0 MB → 14,075 of 14,075).

`GetCascadeTrajectorySteps` has no such ceiling: it returned all 27,561 steps
(48.6 MB) for the store that the other endpoint cut at 12,864. That is why
`recover` calls it, and why a `lock`ed conversation exports in full even though
the app that wrote it cannot display it.

### Genuinely damaged stores

Three `.pb` files are **entirely zero bytes inside** — `613a30da` (27.6 MB),
`6d930628` (33.7 MB) and `f3899755` (48.1 MB) — and each exists in two instances.
Nothing was ever written to them, so no reader, key or protocol will recover a
step from them. Every other store on the profile reads back completely.

`GetAllCascadeTrajectories` is separately capped at about 100 summaries. Beyond
that the list goes stale, which is why `recover` fetches per id rather than via
the list endpoint, and why `agchat sessions` still enumerates the filesystem.

One trap worth repeating: **pass the full conversation id.** A truncated id gets
`trajectory not found (error ID: …)`, which looks exactly like the store being
unreadable.

`--app_data_dir` matters and is easy to get wrong: the server **defaults to
`antigravity-ide`**, so a conversation in the `antigravity` instance is
"not found" unless the flag points there. `recover` derives it from the
session's own instance directory, which is the fix for the most common false
"data is gone" verdict.

The writer is identifiable in the shipped binary, which is what makes the scheme
versioned rather than merely unknown:

```
google3/third_party/jetski/cortex/proto_saver/proto_saver.WithEncryptionKey[…]
google3/third_party/jetski/cortex/proto_saver/proto_saver.(*DiskSaver[…]).hasEncryption
google3/third_party/jetski/cortex/proto_saver/disk_saver.go
```

Encryption is an **option** on `DiskSaver`, so a build that omits it writes a
plain `.pb` — which is presumably how the `.db` generation came about.

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
