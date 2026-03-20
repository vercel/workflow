---
"@workflow/builders": patch
"@workflow/next": patch
---

Add optional projectRoot to builder config to allow explicit resolution of workflow module specifiers without relying on process.cwd(). Threads the root through discovery, SWC transforms, and the Next.js deferred builder while preserving existing behavior when omitted.
