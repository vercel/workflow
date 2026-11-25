---
'@workflow/web-shared': patch
---

Decrypt an event payload with the run key instead of refetching the event, so the payload view keeps the encrypted banner up until the plaintext is ready rather than drawing inline Decrypt buttons over ciphertext.
