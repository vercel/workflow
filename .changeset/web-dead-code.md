---
'@workflow/web-shared': minor
'@workflow/web': minor
---

Remove dead code from the observability UI. `@workflow/web-shared` no longer exports `MenuDropdown` or `MenuDropdownOption`; nothing in this repo or the Vercel dashboard uses them. `hydrateResourceIOWithKey` is now a deprecated alias of `hydrateResourceIOAsync`, which takes the same arguments.
