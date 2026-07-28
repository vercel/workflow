---
'@workflow/builders': patch
---

Add `STREAMING_NORMALIZE_REQUEST_CODE`, a request normalizer that passes the body through as a stream instead of buffering it, for use on pre-auth request paths.
