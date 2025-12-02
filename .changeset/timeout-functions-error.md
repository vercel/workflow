---
"@workflow/errors": patch
"@workflow/core": patch
---

Override setTimeout, setInterval, and related functions in workflow VM context to throw helpful errors suggesting to use `sleep` instead
