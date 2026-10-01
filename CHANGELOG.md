# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-10-01

### Added

- `list` — cross-platform discovery of VS Code Copilot Chat transcripts
  (Windows / macOS / Linux, `Code`, `Code - Insiders`, `VSCodium`, `Cursor`,
  `Windsurf`, `Trae`, plus `--root` and `VSCODE_USER_DIR` overrides).
- `stats` — conversation statistics that separate human turns from agent
  bookkeeping and tool round-trips, plus volume, tool usage, timing and per-day
  activity sections.
- `time` — effective development time with a full sensitivity curve over the
  active-gap cap, phase attribution, longest interruptions and per-day breakdown.
- `tools`, `segments`, `timeline`, `query`, `export`, `formats`, `paths` commands.
- Filters: event type, role, tool name, regex over content/arguments/tool name,
  absolute or relative time windows, and event index ranges.
- Time model with `--cap`, `--break` and `--caps` overrides.
- Output as ANSI-coloured text, JSON, Markdown or CSV, to stdout or `--out`.
- Zero runtime dependencies; streaming parser that never loads the whole file.
- Format adapter architecture with `vscode-transcript` as the built-in adapter;
  unknown event types are preserved rather than dropped.
- 37 `node:test` specs built on synthetic transcripts with hand-computed
  expectations.

[0.1.0]: https://github.com/minicom365/copilot-transcript-stats/releases/tag/v0.1.0
