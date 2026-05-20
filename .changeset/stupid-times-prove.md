---
"@workflow/world": minor
"@workflow/world-vercel": minor
"@workflow/core": patch
---

Pre-signed S3 URLs for nested event refs, with pagination and ref resolution running in parallel. `world.events.list` now accepts `deferRefs: true` to return the page metadata immediately and hand back a `refsResolution` promise; callers that paginate through many pages (e.g. the runtime's event log loader) can fetch the next page while the current page's refs are still resolving.
