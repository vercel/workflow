---
'@workflow/core': patch
---

Fix an unhandled rejection that could exit the process when the encryption-key lookup for a forwarded writable stream failed (for example a run metadata read that timed out) before anything was written to that stream. The lookup now starts on the first write, and a failure rejects that stream instead.
