---
"@workflow/core": patch
---

Use globalThis-backed Map for step function registry to prevent module duplication from splitting the registry in Turbopack dev mode
