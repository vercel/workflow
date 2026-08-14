---
'@workflow/core': patch
---

Fix flaky timing-sensitive tests: stall-proof budgets for the events-consumer deferred-check tests and a sibling-matched budget for the TTL-expiration abort e2e test.
