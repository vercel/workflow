---
"@workflow/core": patch
"@workflow/world": patch
"@workflow/world-vercel": patch
---

Avoid redundant history reads when independent hooks register concurrently. Keep existing single-event requests parallel and reconcile their committed events together before continuing, with the normal history reload when the responses do not cover a complete consecutive suffix.
