---
'@workflow/core': patch
---

Fix an unhandled rejection that could exit the process when looking up the encryption key for a forwarded writable stream failed (for example a run metadata request that timed out) before anything was written to the stream. The lookup now starts on the first write and its failure rejects that stream instead.
