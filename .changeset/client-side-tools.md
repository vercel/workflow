---
'@workflow/ai': patch
---

Support client-side tools in DurableAgent. Tools without an `execute` function now pause the agent loop and return `clientToolCalls` in the result instead of throwing an error.
