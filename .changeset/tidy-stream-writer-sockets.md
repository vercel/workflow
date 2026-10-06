---
"@workflow/core": patch
"@workflow/world": patch
"@workflow/world-vercel": patch
---

Release drained stream writer sockets without closing the shared stream, preserve handle reuse over HTTP, and dispose transports when public writable streams abort. Propagate source failures to readers of flushable stream pipes.
