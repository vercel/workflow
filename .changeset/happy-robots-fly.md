---
"@workflow/web-shared": patch
---

Render the detail panel outside the trace viewer context so hydrated data no longer passes through the web worker's `postMessage` boundary. Fixes `URLSearchParams object could not be cloned` errors.
