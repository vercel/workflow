---
'@workflow/core': patch
---

Fail a live stream read with a `StreamError` naming the index when consecutive reads stall at a chunk the stream reports but never serves, instead of reconnecting to it until the reconnect budget runs out
