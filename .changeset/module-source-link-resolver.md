---
'@workflow/web-shared': minor
---

Add an optional async `resolveModuleSourceUrl` to the trace-viewer sidebar data. The details-panel "Module" link now prefers it over the synchronous `getModuleSourceUrl` (falling back when it's absent or returns nothing), letting hosts resolve the link to the file's real source path and extension.
