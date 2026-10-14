---
"@workflow/core": patch
---

Expose the durability barrier on step writables under `Symbol.for('WORKFLOW_STREAM_DRAIN')`, so a step can wait until an event it wrote is durable before doing further work
