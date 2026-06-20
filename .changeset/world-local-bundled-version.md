---
'@workflow/world-local': patch
---

Skip data-dir version-compat enforcement when the package version is the `bundled` sentinel (framework server bundles), so `world.start()` at server startup no longer throws `Invalid version string: "bundled"`.
