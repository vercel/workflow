---
'@workflow/core': patch
---

Fix an unhandled rejection that could end the process when a stream passed across a workflow boundary (a step return value, a workflow argument, or a stream written into `getWritable()`) failed before its pipe was awaited, such as a returned `fetch()` body whose socket closed (`TypeError: terminated`). The pipe's error still surfaces to the runtime's stream-op handling.
