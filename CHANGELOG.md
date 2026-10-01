# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
