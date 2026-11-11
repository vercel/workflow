---
"@workflow/core": patch
"@workflow/world": patch
"@workflow/errors": patch
"@workflow/world-local": patch
"@workflow/world-postgres": patch
---

Describe `experimental_retention: 0` as auto-delete rather than zero retention. The run's payloads are deleted as soon as it completes, fails, or is cancelled, but run data may still persist in encrypted database backups for a short period after deletion. The option name and behavior are unchanged.

`@workflow/world` now exports the wire value as `RETENTION_AUTO_DELETE`. `RETENTION_ZERO` is kept as a deprecated alias with the same value.
