---
'@workflow/next': major
'@workflow/builders': patch
---

Remove the Next.js lazy discovery/deferred builder path and the `workflows.lazyDiscovery` option.

Fall back to direct generated-file overwrites on Windows when atomic rename is blocked by Next.js dev server file handles.
