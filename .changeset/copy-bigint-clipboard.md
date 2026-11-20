---
'@workflow/web-shared': patch
---

Fix the copy button putting `[object Object]` on the clipboard for payloads that contain a BigInt; BigInt values are now copied as decimal strings in valid JSON.
