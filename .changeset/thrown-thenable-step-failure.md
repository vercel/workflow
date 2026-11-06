---
"@workflow/core": patch
---

Record a step's retry or failure right away when the step throws a thenable that never settles or keeps resolving to itself, or an error that cannot be serialized, instead of losing the event and waiting for queue redelivery. A thrown thenable gets up to 10 seconds to settle (`WORKFLOW_THROWN_THENABLE_TIMEOUT_MS`), and when it settles its reason is recorded as the step error, cause chain included. An error that cannot be serialized is recorded as plain errors that keep its name, message, stack, the first links of its cause chain and its `AggregateError` members.
