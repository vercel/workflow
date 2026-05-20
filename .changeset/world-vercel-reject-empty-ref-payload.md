---
"@workflow/world-vercel": patch
---

Validate ref resolve responses before handing payloads to the workflow runtime. Zero-byte bodies and `Content-Length` mismatches now throw `WorkflowWorldError` instead of corrupting the event log with empty/truncated bytes (which previously surfaced as `Data too short to contain format prefix: expected at least 4 bytes, got 0`).
