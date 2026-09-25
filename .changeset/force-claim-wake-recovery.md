---
'@workflow/core': patch
---

Republish a force-claimed hook's victim wake on every replay within 24 hours of the takeover instead of only while the forced `hook_created` is the claimer's last own event, so a crash before the wake is repaid even when the claimer wrote other events after the creation.
