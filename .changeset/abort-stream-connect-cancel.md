---
"@workflow/core": patch
---

Close a stream read that is cancelled while it is still connecting, so a fast signal-bearing step no longer leaves its abort-stream read open until the server's max duration.
