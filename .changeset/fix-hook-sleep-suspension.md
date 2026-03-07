---
"@workflow/core": patch
---

Fix premature workflow suspension when hooks have buffered payloads and a concurrent sleep or incomplete step is pending
