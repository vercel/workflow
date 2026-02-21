---
"@workflow/core": patch
---

Add browser-compatible AES-256-GCM encryption module with `importKey`, `encrypt`, and `decrypt` functions; update all runtime callers to resolve `CryptoKey` once per run via `importKey()`
