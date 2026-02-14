---
"@workflow/core": patch
---

Handle 409 conflict gracefully when creating wait_completed events, preventing crashes when multiple concurrent invocations race to complete the same wait
