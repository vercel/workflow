---
'@workflow/web': patch
---

The runs, steps, and events observability list views now read from the
metadata-only `world.analytics` namespace when the configured backend provides
one, and fall back to the runtime storage APIs otherwise. Event payloads are
still loaded lazily per event on the runtime path. Hooks listing, detail views,
payload resolution, streams, and mutations are unchanged.
