---
'@workflow/core': patch
---

Verify stream completion on clean EOF in the reconnecting framed reader. Some transport paths normalize a mid-stream abort into a graceful end (the server's max-duration cut can reach the client as a clean EOF), which previously read as end-of-stream and silently truncated live reads at the server's 2-minute connection cap. On EOF the reader now checks the stream's authoritative metadata and reconnects from the next chunk unless the stream is complete and every chunk up to `done` was delivered.
