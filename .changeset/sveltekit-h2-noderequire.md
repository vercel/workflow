---
'@workflow/sveltekit': patch
---

Fix HTTP/2 requests failing in SvelteKit production builds (undici's bundled `node:http2` could not load, falling back to a stub).
