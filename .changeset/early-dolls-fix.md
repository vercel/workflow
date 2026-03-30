---
"@workflow/core": patch
"@workflow/cli": patch
"@workflow/web-shared": patch
---

Add `enc2` encryption for serialized workflow data, which includes key binding for each operation, also reducing the likelihood of nonce reuse for long-running workflows.
