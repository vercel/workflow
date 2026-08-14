---
'@workflow/builders': patch
---

Emit `manifest.json` entries in sorted order so identical builds produce a byte-identical manifest instead of one that varies with concurrent discovery order.
