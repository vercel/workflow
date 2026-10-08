---
'@workflow/cli': minor
---

Make `workflow inspect` reliable for long runs: `--all` pages `steps`, `events` and `sleeps` to the end, `inspect event <id>` is supported, `-n` accepts the short workflow name the runs table shows, `st` means streams, `inspect stream` exits non-zero on failure, and `stream`/`step` lookups require `--runId` instead of guessing a run.
