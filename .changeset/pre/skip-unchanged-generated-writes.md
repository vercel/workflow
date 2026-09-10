---
'@workflow/builders': patch
'@workflow/next': patch
'@workflow/nitro': patch
---

Emit `manifest.json` in a stable order and remove a redundant compilation round per no-op rebuild in Next dev.
