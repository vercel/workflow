---
'@workflow/core': patch
---

Fix `Date` subclassing inside workflow functions. The deterministic `Date` override in the workflow VM is now a class that preserves `new.target`, so subclasses like `TZDate` from `@date-fns/tz` keep their identity, methods, and fields.
