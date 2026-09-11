---
'@workflow/world-postgres': patch
---

Fix stream readers leaking EventEmitter listeners on EOF, initial query failure, and World close, and fail pending readers when the World is closed.
