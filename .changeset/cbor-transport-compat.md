---
"@workflow/world-vercel": patch
"@workflow/world": patch
"@workflow/core": patch
---

Bump specVersion to 3 and gate CBOR queue transport on spec version. Old deployments (specVersion < 3) receive JSON queue messages; new deployments receive CBOR. Handler uses dual transport to deserialize both formats. Fixes replay/reenqueue from dashboard to older deployments.
