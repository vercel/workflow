---
"@workflow/builders": patch
---

Fix step bundle discovery and externalization for SDK serde classes

- Broaden `importParents` tracking to all imports (not just file extensions) so `parentHasChild()` works through bare specifier imports
- Include `workflow/runtime` in discovery inputs so SDK serde classes like `Run` are always discovered
- Bundle node_modules deps instead of externalizing with broken relative paths
