---
'@workflow/world-vercel': patch
---

Default region-tagged run IDs to `iad1` instead of the `unknown` (0) sentinel when no `region` option or `VERCEL_REGION` is available. Run IDs are now always tagged with a concrete, routable region, matching the server's default-region resolution and avoiding the `tagged: true, region: null` state.
