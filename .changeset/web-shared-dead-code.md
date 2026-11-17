---
'@workflow/web-shared': minor
---

Remove dead code. `MenuDropdown` and `MenuDropdownOption` are no longer exported, since nothing in this repo or the Vercel dashboard uses them, and `hydrateResourceIOWithKey` is now a deprecated alias of `hydrateResourceIOAsync`.
