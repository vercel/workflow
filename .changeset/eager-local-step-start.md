---
"@workflow/core": patch
---

The retained owner starts a step body it runs locally as soon as its `step_started` is staged, instead of waiting for the durability barrier; the input is still acknowledged only after its prefix is durable, and a failed barrier still fails the run. Steps dispatched to other invocations still wait for the durable start.
