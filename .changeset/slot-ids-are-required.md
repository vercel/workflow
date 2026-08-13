---
'@workflow/world': patch
'@workflow/world-testing': patch
'@workflow/world-local': patch
'@workflow/world-postgres': patch
'@workflow/world-vercel': patch
---

Slot-numbered event ids are a requirement of the World contract, not a capability. The `slotEventIds` flag is gone, and the conformance suite now fails a World whose event ids are not positions.
