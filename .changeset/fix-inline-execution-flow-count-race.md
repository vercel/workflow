---
"@workflow/world-testing": patch
---

Fix race condition in test server's flow invocation counter that caused intermittent failures in the inline-execution test suite (e.g. "sequential steps complete in a single flow invocation"). The counter is now incremented before awaiting the flow handler, so the count is observable as soon as the run transitions to completed.
