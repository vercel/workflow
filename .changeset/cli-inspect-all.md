---
'@workflow/cli': minor
---

Add `--all` to `workflow inspect steps`, `events` and `sleeps`: it follows cursors to the last page and prints every row. A listing that stops early now names the next page's cursor (on stderr with `--json`), and a run whose first page fell back to storage no longer sends that page's cursor to analytics.
