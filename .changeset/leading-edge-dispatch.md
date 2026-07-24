---
"@workflow/core": patch
"@workflow/world": patch
---

Stream writes dispatch the first chunk of an idle stream immediately (flush window default 0 instead of 10ms). Fast producers keep full batching via in-flight accumulation; set `WORKFLOW_STREAM_FLUSH_INTERVAL_MS` > 0 to opt into a windowed leading edge.
