# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.3] - 2026-10-01

### Added

- **`agchat recover --session <id>`** — exports the *complete* trajectory of an
  Antigravity conversation by driving the bundled language server. The `.pb` key
  is not on disk, but the server holds it and decrypts on demand, so this recovers
  the early steps the app's own UI stops showing once a conversation grows.
  Verified on a real 9,308-step conversation whose `transcript_full.jsonl` lost
  78% of its head: the endpoint returned **all 9,308 steps** (56.9 MB) in 2.5 s.
- `src/hosts/antigravity-recover.js` — `defaultLsBinary()`, `launchLanguageServer()`,
  `postJson()`, `recoverTrajectory()`, `countSteps()`. Zero dependencies.

### Fixed

- The port parser now skips the `listening … for HTTPS (gRPC)` line. The phrase
  `for HTTP` is a prefix of `for HTTPS`, so the naive regex captured the gRPC
  port and the request failed with "Client sent an HTTP request to an HTTPS
  server".
- `recover` derives `--app_data_dir` from the conversation's own instance. The
  server **defaults to `antigravity-ide`**, so a conversation in `antigravity`
  otherwise reads as "trajectory not found in any store".

### Documented limitations (observed, not specific to this tool)

- A few very large stores are corrupt: HTTP 500, non-deterministic reproduction.
- `GetAllCascadeTrajectories` is capped at ~100 summaries, so listing goes stale;
  `recover` fetches per id instead.

## [0.3.2] - 2026-10-01

A follow-up investigation of the two external references turned up one fact that
v0.3.1 had **backwards**, and one number that changes what the tool should say.

### Fixed

- **The store generations were inverted.** v0.3.1 described `.db` as the legacy
  format and `.pb` as current. Measured across 350 stores on one install it is the
  reverse: `.pb` (2025-11 … 2026-08-13) is always entropy 8.00 = encrypted, while
  `.db` (2026-08-03 onward) is always entropy 3.1–5.1 = **plaintext SQLite whose
  blob columns are ordinary protobuf**. The app stopped encrypting around
  **2026-08-14**, and no conversation exists in both formats.
- `sessions` now prints `store = pb (encrypted, older) | db (plaintext, newer)`.

### Added

- **`lock` in the `head` column.** A conversation whose content exists *only* in
  the encrypted `.pb` store is now marked explicitly. On the measured install that
  is **207 of 294 `.pb` conversations** — they have no transcript and no overview,
  so nothing about them is recoverable offline. Previously they rendered as a bare
  `-`, indistinguishable from an empty conversation.
- `storeNote` on each session record describing what its store kind implies.

### Investigated, with the result recorded rather than shipped

- **Encryption is an option, not a constant.** The shipped language server
  contains `jetski/cortex/proto_saver.WithEncryptionKey` and
  `DiskSaver.hasEncryption` (source: `proto_saver/disk_saver.go`), which is why a
  later build could write plaintext. This also explains the versioned scheme:
  `decryptV4` / `decryptV5` exist as separate symbols.
- **`.db` is not worth reading as a separate source.** For 50 of the 56 stores the
  merged logs already cover the identical step range, and the other 6 add two
  steps each. It is documented as a fallback, not implemented.
- **Compression was re-checked and ruled out**, because entropy 8.0 rules out a
  plaintext header but *not* a magic-less codec: raw deflate, zlib, gzip and
  brotli all fail at every header offset, and the file's zero-byte density matches
  random data (34/8603 ≈ 1/256).
- **Three `.pb` files (3 conversations, duplicated across two instances, 27–48 MB)
  are entirely zero bytes** — allocated but never written, so those were lost
  rather than encrypted.
- **Every offline key location was re-checked and is still empty**: the
  Electron/Chromium master key authenticates the `v10` secrets in `state.vscdb`
  but decrypts no `.pb`; every `v10` value in both profiles was decrypted and the
  only one is a GitHub OAuth token; Windows Credential Manager holds just
  `gemini:antigravity` (OAuth); `app.asar` contains no crypto at all.

## [0.3.1] - 2026-10-02

Everything in this release comes from one correction: **`transcript_full.jsonl` is
not a complete record, and `conversations/<id>.pb` is genuinely encrypted.** The
previous version asserted the opposite for both. Both claims were re-measured on a
real install, and the tool now recovers what actually survives.

### Fixed

- **`transcript_full.jsonl` can lose the head of a long conversation.** On a real
  9,308-step session the log started at step **7,231** — 78% of the conversation
  was absent from the only file that looked authoritative. `agchat` previously
  reported totals for that fragment as if they were the whole session.
- **`overview.txt` is now a source.** It sits in the same `logs/` folder, uses the
  same JSONL schema, and holds the full step skeleton for the steps the transcript
  dropped (`"status": "CLEARED"` marks a step whose text the app cleared). Every log
  in the folder is now merged by `step_index`, keeping the richest copy of each
  step: for the session above that is 2,077 → 4,750 events, with the early timeline
  and 248 early tool calls recovered.
- **`docs/ANTIGRAVITY.md` no longer claims "nothing relevant is encrypted."** It now
  records the measurements: `.pb` entropy 8.000 bits/byte, no container or
  compression magic, no protobuf structure at the top level.

### Added

- **`parseTranscriptSet()`** — merges several logs that describe the same
  conversation. Formats exposing an `ORDER_KEY` are merged by that key (richest copy
  wins, then source priority); anything else is concatenated in order.
- **`coverageOf()` / a coverage block in `stats`** — separates "steps present" from
  "steps that still carry text", and reports `firstTextStep` so a partial
  conversation is never presented as a complete one.
- **`head` column in `sessions`**: `full` (content complete), `skel` (head survives
  only as a cleared skeleton), `lost` (head missing from every log), `-` (no log).
  `unrecoverableHeadSteps` distinguishes "gone" from "recoverable via overview".
- **Warnings** in `stats` naming the encrypted store when a conversation's text is
  partial, plus a coverage table in the report header.
- `logSourcesFor()` and `stepRangeOf()` in the Antigravity host, and a
  `test/coverage.test.js` suite (11 specs) with a sandbox fixture for a truncated
  conversation.

### Documented, not fixed

- **Offline decryption of `.pb` is not possible.** On Windows the Electron/Chromium
  master key (`os_crypt.encrypted_key`, unprotected with DPAPI) is *correct* — it
  authenticates the `v10` secrets in `state.vscdb` — but it does not decrypt any
  `.pb`; AES-128/192/256 in CTR and CBC, and GCM with the tag at either end, over
  nonce lengths 12/16 and header skips 0/1/2/4/8, all failed. No DPAPI-wrapped blob
  exists anywhere in the profile (28,168 files scanned), so the key is not stored
  via Electron `safeStorage` either. The upstream tool's own README takes the key
  from the macOS Keychain and asks Windows users to supply it manually — the key is
  not derivable from the filesystem. The remaining routes are the app's own reader
  (the bundled language server) and the `overview.txt` skeleton.

## [0.3.0] - 2026-10-01

**Renamed** `copilot-transcript-stats` → **`agent-chat-toolkit`**, CLI
`transcript-stats` → **`agchat`**. The old repository URL redirects on GitHub.

Antigravity grew a second dimension — *instances* — and the tool learned to tell
"on disk" from "visible in the app".

### Added

- **Instance discovery for Antigravity.** Every `~/.gemini/*antigravity*` directory is
  catalogued separately: `antigravity` (app), `antigravity-ide` (IDE build),
  `antigravity-backup` (snapshot of an older profile), `antigravity-history` (a
  third-party extension's cache). Conversations that only exist in a backup are now
  found instead of ignored.
- **Sidebar index reader** (`src/hosts/antigravity-index.js`). Antigravity's
  `antigravityUnifiedStateSync.trajectorySummaries` is base64-wrapped protobuf, not
  encrypted; it is decoded with a generic wire-format reader to recover conversation
  ids, titles, step counts, timestamps and workspace URIs.
- **`src/protobuf.js`** — a minimal, read-only protobuf wire-format walker. Identifies
  timestamps by shape, UTF-8 by decodability and identifiers by pattern, so it works
  without a `.proto` schema and reports nothing rather than guessing.
- **Visibility reporting.** `sessions` gained `idx` (app index: `yes`/`no`/`?`),
  `store` (`pb` current, `db` legacy, `-` absent) and an `instance` column, plus
  `--instance`, `--not-indexed` and `--recoverable` filters. A conversation can be
  complete on disk and absent from the app's index — the state that looks like data
  loss.
- App profiles are matched to instances **by identifier overlap**, with IDE builds
  matched only to IDE profiles; a snapshot instance reports visibility as unknown
  rather than claiming it.
- `HTTPS_PROXY`-free structured logging: `AGCHAT_DEBUG=1` prints stack traces.
- `docs/ANTIGRAVITY.md` — what is plaintext, what is protobuf, where the language
  server would actually be needed, and why it is not needed here.
- Sandbox fixtures for two extra instances, an IDE profile and a sidebar index built
  by a fixture-only protobuf encoder (`tools/sandbox-protobuf.mjs`).

### Changed

- `conversation_summaries.db` is no longer the only catalog: sidebar index, annotation
  files and the history extension's `cache.json` are merged, with an explicit source
  list per conversation.
- Implausible timestamps (sentinel `0001-01-01` values) are rejected instead of being
  reported as real dates.
- Test counts: 65 unit specs and 58 sandbox checks (was 55 / 46).

### Notes

- The tool remains **read-only** for Antigravity stores. Rebuilding
  `trajectorySummaries` would mean writing protobuf into live global state, where a
  mistake costs every sidebar entry — a worse outcome than a missing conversation.
  Detection plus `show`/`export` is the safe path.

## [0.2.0] - 2026-10-01

The tool becomes multi-host: it now reads Antigravity conversations as well as VS Code
Copilot Chat, and can repair a conversation that has gone missing from the history
panel.

### Added

- **Host abstraction** (`src/hosts/`). A host supplies discovery plus a conversation
  catalog; every command works across all of them. Built-in hosts: `vscode`,
  `antigravity`.
- **`hosts`** — detected hosts, data roots, conversation counts, total size.
- **`sessions`** (alias `list`) — one catalog across hosts and workspaces, including
  conversations whose index entry is missing (marked `orphan`).
- **`find`** — keyword search across hosts with four detail levels (1 compact,
  2 dialogue, 3 actions, 4 audit), level-aware so tool output cannot bury a prose match.
- **`show`** — print one conversation at a chosen level.
- **`move`** — copy a VS Code conversation (chat state + agent transcript + index entry)
  into another `workspaceStorage` folder. Dry run by default, mandatory `--data-dir`,
  timestamped `state.vscdb` backup, source never modified, idempotent.
- **`src/safety.js`** — write-safety gate: no implicit target, live OS-default profiles
  refused, dry run by default, host-must-be-closed, backup before first write.
- **`src/sqlite.js`** — zero-dependency access to `state.vscdb` and
  `conversation_summaries.db` through the built-in `node:sqlite`, with graceful
  degradation when the module is unavailable.
- **Antigravity format adapter** — user/AI/tool/system event classification, tool-result
  pairing with the request that produced it (giving tool names, runtime and failure
  rates), tool output isolated from prose, `<USER_REQUEST>` unwrapping.
- **Format registry** (`src/formats/index.js`) with structural sniffing, so a future
  producer update cannot break detection.
- **Sandbox tooling**: `tools/make-sandbox.mjs` generates a fully synthetic user-data
  tree for both hosts; `tools/sandbox-e2e.mjs` runs the real CLI against it and asserts
  the safety properties (46 checks).
- **`Dockerfile.verify`** — runs the unit suite and the sandbox in a throwaway Linux
  container with no host mounts.

### Changed

- `parseTranscript` / `parseLines` / `peekTranscript` auto-detect the format and call an
  optional adapter `finalize()` pass for cross-event pairing.
- Statistics are format-agnostic: human/assistant/tool/system classification comes from
  the normalised event, not from hard-coded type names. Added `text.observationChars`
  (tool output volume, never prose), `counts.toolUnknown`, `counts.toolRequests`.
- `VSCODE_USER_DIR` now **replaces** the product list instead of adding to it, so a
  sandbox override sees only the sandbox. OS-default roots remain guarded for writes.
- `machineLineShare` counts tool events and turn markers, and no longer counts
  `session.start`.
- VS Code adapter pairs each `tool.execution_complete` with its start event, so a tool
  badge carries its status and a readable argument summary.
- Default test script uses a glob (`node --test "test/**/*.test.js"`), which is required
  on current Node releases.
- Line endings normalised via `.gitattributes`.

### Removed

- `renderList` (the VS Code-only transcript table) — superseded by `sessions`.

### Tests

55 unit specs (was 37) plus 46 sandbox end-to-end checks. Verified on Windows/Node 26
and inside `node:24-alpine` with `--network none`.

## [0.1.0] - 2026-10-01

### Added

- `list` — cross-platform discovery of VS Code Copilot Chat transcripts.
- `stats` — conversation statistics that separate human turns from agent bookkeeping and
  tool round-trips, plus volume, tool usage, timing and per-day activity.
- `time` — effective development time with a full sensitivity curve over the active-gap
  cap, phase attribution, longest interruptions and per-day breakdown.
- `tools`, `segments`, `timeline`, `query`, `export`, `formats`, `paths`.
- Filters: event type, role, tool name, regex over content/arguments/tool name, absolute
  or relative time windows, event index ranges.
- Time model with `--cap`, `--break`, `--caps`.
- Output as coloured text, JSON, Markdown or CSV, to stdout or `--out`.
- Streaming parser; zero runtime dependencies.
- 37 `node:test` specs on synthetic transcripts with hand-computed expectations.

[0.2.0]: https://github.com/minicom365/agent-chat-toolkit/releases/tag/v0.2.0
[0.1.0]: https://github.com/minicom365/agent-chat-toolkit/releases/tag/v0.1.0
