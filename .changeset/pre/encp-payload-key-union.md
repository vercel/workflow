---
'@workflow/core': minor
---

Teach the serialization layer to read and write `encp` sealed envelopes via a `PayloadKey` union, so a cross-run writer can encrypt with only a public key. Existing symmetric call sites are unaffected.
