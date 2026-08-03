---
'@workflow/cli': patch
---

`inspect` list views (runs, steps, events, sleeps) now read from the optional `world.analytics` namespace when the backend provides one, falling back to the runtime storage APIs otherwise. Hook listing stays on the runtime storage APIs (the analytics rows omit `ownerId` and the hook token). Payload/detail views are unchanged. The `--withData` flag is deprecated for list views; use `workflow inspect <resource> <id>` to view payloads for a single resource.
