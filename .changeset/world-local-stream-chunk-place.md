---
"@workflow/world-local": patch
---

Name each stream chunk as it lands, after every chunk already in the stream, so a write that stalled before landing no longer lands ahead of chunks a reader already read.
