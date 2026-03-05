---
'@workflow/world-local': patch
'@workflow/world-postgres': patch
---

Fix `hooks.list()` default sort order to ascending (creation order) in world-local and world-postgres, matching world-vercel behavior. Also fix world-postgres `hooks.list()` to respect the `sortOrder` pagination parameter instead of hardcoding descending order.
