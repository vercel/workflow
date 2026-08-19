---
'@workflow/builders': patch
'@workflow/next': patch
'@workflow/nitro': patch
---

Skip rewriting unchanged generated files and emit `manifest.json` in a stable order, so a no-op rebuild no longer triggers a redundant compilation round in Next dev.
