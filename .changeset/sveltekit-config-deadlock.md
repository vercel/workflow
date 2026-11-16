---
'@workflow/sveltekit': patch
---

Read SvelteKit's options from its Vite plugin in a `config` hook instead of loading the config again, so `svelte-check` and the Svelte language server no longer hang and exit silently with SvelteKit 3. A custom `files.routes` in SvelteKit 3 is now honored too.
