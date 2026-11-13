---
"@workflow/world": patch
---

Deprecate the optional `runs.experimentalSetAttributes` World method and `ExperimentalSetAttributesResult`. The SDK no longer calls it; `setAttributes()` writes `attr_set` events through `events.create`.
