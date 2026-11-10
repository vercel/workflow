---
"@workflow/web-shared": patch
---

Show a run's start Hook in the trace viewer and hook lists. A start Hook has no `hook_created` event (the run's creation stands for it), so its span and every `hook_received` delivered to it were dropped from the trace.
