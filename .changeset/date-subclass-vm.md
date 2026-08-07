---
'@workflow/core': patch
---

Fix `Date` subclassing inside workflow functions. The deterministic `Date` override in the workflow VM now forwards `new.target` via `Reflect.construct`, so subclasses like `TZDate` from `@date-fns/tz` keep their identity, methods, and fields. Calling `Date()` without `new` now returns the (fixed) time string per spec, instead of a `Date` object.
