---
"@workflow/sveltekit": patch
"@workflow/builders": patch
---

Fix SvelteKit production server crash at boot if a world package pulls cosmiconfig into the server bundle.
