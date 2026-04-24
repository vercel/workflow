---
"@workflow/errors": patch
---

`Ansi` rendering helpers moved from the package root to a new `@workflow/errors/ansi` subpath export so consumers that only need error classes no longer pull `chalk` into their bundle.
