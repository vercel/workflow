---
"@workflow/core": patch
---

Dynamic `start()` refusals (opt-in, validation, same-deployment, World capability, execution-context budget) are now fatal, so a `start()` inside a step fails fast instead of retrying.
