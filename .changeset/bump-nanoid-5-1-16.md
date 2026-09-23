---
"@workflow/core": patch
---

Security: bump `nanoid` from 5.1.6 to 5.1.16 to fix [GHSA-28wg-ghj8-5hjv](https://github.com/advisories/GHSA-28wg-ghj8-5hjv) (high). `@workflow/core` pins `nanoid` exactly, so apps could not pick up the patched release without an override.
