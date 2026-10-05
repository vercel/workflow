---
'@workflow/swc-plugin': patch
---

Stabilize nested step IDs across scopes and SWC transform modes. Self-hosted
runs that already recorded one of the previously colliding IDs may report a
replay divergence if they continue on upgraded code; restart those in-flight
runs after upgrading.
