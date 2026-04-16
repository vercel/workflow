---
---

Disable community world E2E jobs on `main` CI and drop them from the required checks. Community worlds target an older spec version and don't yet support the CBOR queue transport; they continue to run on `stable`.
