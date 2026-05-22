---
"@workflow/core": patch
"@workflow/web-shared": patch
"@workflow/web": patch
---

Make encrypted markers clickable to trigger decryption and detect encryption at run level before span selection. Persist `features.encryption` flag in `executionContext` at run creation so the UI can detect encryption without a probe fetch.
