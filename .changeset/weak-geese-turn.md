---
"@workflow/ai": patch
---

Propagates the caller’s AbortSignal to reconnect /stream?startIndex=... requests and their stream wrapper, ensuring client aborts consistently cancel both the initial chat POST and any reconnect fetches.
