---
'@workflow/web-shared': minor
---

Replace the trace-viewer sidebar's synchronous `getModuleSourceUrl` with a single async `resolveModuleSourceUrl`. The details-panel "Module" link awaits it, so hosts can resolve the link to the file's real source path and extension (e.g. by looking it up in the deployment's source tree). Renders the row as plain text until resolved or when no link applies.
