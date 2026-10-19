---
"@workflow/core": patch
---

Security: remove the `nanoid` dependency (pinned at 5.1.6, affected by [GHSA-28wg-ghj8-5hjv](https://github.com/advisories/GHSA-28wg-ghj8-5hjv)). Default hook tokens now come from a built-in copy of the same generator, so tokens and seeded random values stay identical for runs recorded on earlier versions. Upgrading `nanoid` itself would have changed them, because `nanoid@5.1.16` draws a different number of random bytes per id.
