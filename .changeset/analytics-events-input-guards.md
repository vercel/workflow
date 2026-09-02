---
'@workflow/world': minor
'@workflow/world-vercel': minor
'@workflow/web': patch
---

Validate `world.analytics` arguments up front: an invalid id, an out-of-range page limit, an oversized attribute filter, or a half-open `startTime`/`endTime` window now throws a `RangeError` naming the limit instead of failing the request. Adds `ANALYTICS_RUN_SCOPED_PAGE_LIMIT`, `ANALYTICS_PAGE_LIMIT` and `ANALYTICS_MAX_ATTRIBUTE_FILTERS`.

Deprecate `analytics.events.listByCorrelationId()` in favour of `analytics.events.list({ runId, correlationId })`.

Fix `analytics.attributes.list()` timestamps being shifted by the local UTC offset.
