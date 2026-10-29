---
"@workflow/core": patch
"@workflow/world": patch
"@workflow/world-vercel": patch
---

Add an experimental `WORKFLOW_STREAM_WS_PIPELINE_DEPTH` (default 1, max 4) that lets an open stream WebSocket carry several write requests before their replies
