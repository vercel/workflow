---
'@workflow/cli': patch
---

`inspect` list views (runs, steps, events, hooks, sleeps) now read from the optional `world.analytics` namespace when the backend provides one, falling back to the runtime storage APIs otherwise. Payload/detail views are unchanged. The `--with-data` flag is deprecated for list views; use `workflow inspect <resource> <id>` to view payloads for a single resource.
