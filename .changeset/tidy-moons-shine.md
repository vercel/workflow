---
'@workflow/world': minor
---

Export `readRunRetention`, `purgesUserDataOnFinish` and the `RETENTION_ZERO` / `RETENTION_DEFAULT` wire values from `@workflow/world`, so every World that implements retention resolves the `$retention` attribute through one parser rather than its own.

The sharing is the point. Two hand-written parsers can drift, and drift here means one World deleting a run that another keeps — the parser's whole job is to be strict about near-misses like `' 0 '`, `'0.0'`, `'-0'` and `'0s'`, any of which a lenient reading would treat as zero.
