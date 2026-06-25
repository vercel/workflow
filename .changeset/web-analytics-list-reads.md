---
'@workflow/web': patch
---

The runs and steps observability list views now read from the metadata-only
`world.analytics` namespace when the configured backend provides one, and fall
back to the runtime storage APIs otherwise. Events and hooks listing, detail
views, payload resolution, streams, and mutations are unchanged.
