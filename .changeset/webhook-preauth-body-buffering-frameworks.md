---
'@workflow/astro': patch
'@workflow/sveltekit': patch
---

Stop buffering the request body before webhook token validation, so invalid-token requests to the public webhook route are rejected without consuming the body.
