---
'@workflow/core': patch
---

Update nanoid to ^5.1.16 — closes CVE-2026-67214 (5.x < 5.1.16), and the caret range lets the dependency dedupe with other nanoid 5.x consumers in the host app instead of forcing a second copy.
