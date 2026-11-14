---
'@workflow/web-shared': patch
---

Decrypt an event payload from the run key alone instead of refetching the event, so the payload view goes from "Decrypting…" straight to plaintext rather than flashing inline Decrypt buttons over ciphertext.
