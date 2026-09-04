---
'@workflow/core': minor
---

Carry the owning run's public key in forwarded `WritableStream` descriptors, so a run writing into another run's stream seals frames with no run fetch and no key-API round trip.
