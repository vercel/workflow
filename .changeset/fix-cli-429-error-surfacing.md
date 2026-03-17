---
"@workflow/cli": patch
---

Surface HTTP errors (e.g. 429 rate limit) from encryption key fetch instead of silently falling back to encrypted placeholders. Add 429 to the status text map.
