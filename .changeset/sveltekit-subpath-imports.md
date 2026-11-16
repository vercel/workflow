---
"@workflow/sveltekit": patch
---

Leave package.json subpath imports such as `#lib/*` to Vite, the same way `$lib` is handled, so SvelteKit 3 apps can import them from step files.
