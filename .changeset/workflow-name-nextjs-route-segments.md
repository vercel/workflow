---
"@workflow/core": patch
---

Allow parentheses and square brackets in workflow names

A workflow name is derived from the module path it is defined in, so Next.js App
Router conventions end up in the name verbatim. `SAFE_WORKFLOW_NAME_PATTERN` did
not permit `(`, `)`, `[` or `]`, so any workflow inside a route group
(`app/(dashboard)/…`) or a dynamic segment (`app/[teamId]/…`, `app/[...slug]/…`)
threw `Invalid workflow name` before it could be enqueued, with no way to
override the generated name.

These characters are inert in the queue name the pattern guards: `ValidQueueName`
already accepts any suffix after its prefix, and the name is never interpolated
into a URL or a SQL identifier.
