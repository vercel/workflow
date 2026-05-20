---
"@workflow/world-vercel": patch
---

Validate ref resolve responses before handing payloads to the workflow runtime. Bodies shorter than the 4-byte format prefix the SDK always writes (zero-byte or truncated), as well as `Content-Length` mismatches, now throw `WorkflowWorldError` instead of corrupting the event log with empty/truncated bytes (which previously surfaced as `Data too short to contain format prefix: expected at least 4 bytes, got 0`).
