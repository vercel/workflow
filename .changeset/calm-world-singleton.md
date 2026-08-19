---
'workflow': patch
'@workflow/core': patch
---

Reuse the runtime World singleton when the workflow entrypoint initializes its queue handler, avoiding duplicate resources for stateful async World factories.
