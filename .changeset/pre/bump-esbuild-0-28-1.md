---
'@workflow/builders': patch
'@workflow/cli': patch
---

Upgrade esbuild to ^0.28.1 to resolve GHSA-gv7w-rqvm-qjhr (missing binary integrity verification before executing downloaded binaries).
