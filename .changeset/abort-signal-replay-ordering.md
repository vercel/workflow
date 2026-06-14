---
'@workflow/core': patch
---

Fix a race where an `AbortController` aborted from one step was not yet reflected in a `controller.signal` passed to a subsequent step. The abort delivery now participates in the suspension gate, so downstream step arguments are serialized only after the signal has aborted.
