---
'@workflow/core': patch
---

Clean-room rewrite of the event-log consumer (`EventsConsumer`): coalesced drain scheduling, orphan-probe invalidation on any activity (subscribe/append/consume, not just subscribe), quiescence re-verification plus a final re-offer before declaring an event unconsumed, and the end-of-log sentinel no longer advances the cursor when consumed.
