---
'@workflow/world-local': patch
---

Reject dots in entity IDs and empty `correlationId` values in `assertSafeEntityId` — defense-in-depth follow-up to the path traversal fix. Dots in IDs would be misparsed by `stripTag()` / `getObjectCreatedAt()`, and empty `correlationId` would produce malformed `${runId}-` composite keys.
