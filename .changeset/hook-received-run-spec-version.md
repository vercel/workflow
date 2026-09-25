---
'@workflow/core': patch
---

Stamp `hook_received` with the resumed run's spec version when it is older than the SDK's, so an older or non-JS runtime can still read the run's event log.
