---
'@workflow/world': minor
'@workflow/world-vercel': minor
'@workflow/web': patch
---

`world.analytics` now validates its arguments before making a request: an invalid id, an out-of-range `pagination.limit`, an oversized attribute filter, or a `startTime` without a matching `endTime` throws a `RangeError` naming the limit, instead of looking like an empty result. Adds `ANALYTICS_RUN_SCOPED_PAGE_LIMIT`, `ANALYTICS_PAGE_LIMIT` and `ANALYTICS_MAX_ATTRIBUTE_FILTERS` if you want to check the bounds yourself.

Deprecates `analytics.events.listByCorrelationId()`. Use `analytics.events.list({ runId, correlationId })`, which also accepts an `eventType` filter.
