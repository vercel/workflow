---
'@workflow/core': minor
---

Add the `encp` sealed-box encryption primitive: X25519 keypairs derived from the existing per-run key material, letting cross-run writers encrypt with only a public key. Not yet wired into any write path.
