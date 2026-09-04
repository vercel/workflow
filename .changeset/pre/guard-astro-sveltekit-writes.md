---
'@workflow/astro': patch
'@workflow/sveltekit': patch
---

Stop rewriting generated files whose content is unchanged, so a no-op rebuild no longer invalidates them in the dev server.
