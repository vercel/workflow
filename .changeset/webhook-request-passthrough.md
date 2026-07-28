---
'@workflow/astro': patch
'@workflow/sveltekit': patch
---

The generated webhook route now passes the incoming request directly to its handler instead of copying it into a new `Request`, so the request body is no longer read before the handler runs.
