# Write safety

A user-data directory holds the editor's *live* state. The wrong write there can lose
the chat history of every workspace, and there is no undo. This document states exactly
what the tool refuses to do, and how that is verified.

## The rules

Every operation that writes is gated by `src/safety.js`.

| # | rule | failure mode it prevents |
| --- | --- | --- |
| 1 | `--data-dir` is mandatory; there is no implicit target | a typo silently hitting the live profile |
| 2 | A target inside an **OS-default** product root is refused unless `--i-know-what-im-doing` | automation or a stale env var writing to the real profile |
| 3 | Dry-run is the default; `--apply` is required to write | a "just look at it" command mutating state |
| 4 | Writing while the host application is running is refused unless `--allow-running` | the editor flushing its in-memory index over the change, losing entries |
| 5 | `state.vscdb` is copied to `state.vscdb.bak-<timestamp>` before the first write (never overwriting an existing backup) | an unrecoverable index |
| 6 | The source is never modified | losing the conversation you were trying to rescue |
| 7 | Nothing is ever deleted | — |
| 8 | Re-running is idempotent | duplicated entries, repeated copies |

Rule 2 deliberately looks at **OS defaults only**, computed with the
`VSCODE_USER_DIR` / `GEMINI_DIR` override ignored. Those variables are how the sandbox
points the tool at synthetic data, so treating them as "live" would make the sandbox
unusable while protecting nothing: the dangerous path is the real profile, and that is
what stays guarded.

```
REAL_ROOT    refusing to write into a live data directory
NO_TARGET    no --data-dir was given
HOST_RUNNING Code.exe (or Antigravity) is running
```

## What a migration touches

`transcript-stats move` copies, never moves:

```
source storage                            target storage
  chatSessions/<id>.jsonl        ───────▶   chatSessions/<id>.jsonl          (only if absent or smaller)
  GitHub.copilot-chat/transcripts/<id>.jsonl ─▶  …/transcripts/<id>.jsonl
  (unchanged)                               state.vscdb.bak-<stamp>          (backup, first write only)
                                            state.vscdb                       (+ index entry)
                                            state.vscdb.backup                (+ index entry, if present)
```

The index entry is taken from the source index when available, otherwise rebuilt from
the conversation file itself (`buildEntryFromFile`), which is also how an orphaned
conversation is recovered.

## Verifying it yourself

The verification never touches your profile. It builds a synthetic tree in a temp
directory, points `VSCODE_USER_DIR` / `GEMINI_DIR` at it, and runs the real CLI as a
child process.

```bash
npm run verify
```

Asserts, among 46 checks:

- a dry run leaves the target storage **byte-identical** (directory digest before/after)
- a dry run leaves the source **byte-identical**
- `move` without `--data-dir` fails with a message naming the flag
- after `--apply`: files arrive, the index entry appears, a `.bak-…` file exists
- the **source** is still byte-identical and still indexed
- re-running reports "Nothing to do"
- an unknown `--to` target and a self-migration both fail loudly

For isolation stronger than a temp directory, run the same suite in a container with no
network and no host mounts:

```bash
docker build -f Dockerfile.verify -t transcript-stats-verify .
docker run --rm --network none transcript-stats-verify
```

## If you do want to write to the real profile

1. **Close the editor completely.** `move` refuses otherwise; the refusal is not a
   nuisance, it is the difference between a working repair and a lost index.
2. Take your own copy first: `cp -r <User> <User>.manual-backup`.
3. Run the dry run and read the file list.
4. Only then: `--apply --i-know-what-im-doing`.
5. Reopen the editor and check the history panel.

If the change does not take, `state.vscdb.bak-<timestamp>` is the original file byte for
byte; restore it and reopen.
