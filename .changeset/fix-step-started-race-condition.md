---
'@workflow/world-postgres': patch
---

Add atomic terminal-state guards to all entity UPDATE operations to match the Vercel world's DynamoDB conditional expressions. Previously, several UPDATEs had no WHERE clause guard on status, allowing concurrent requests to bypass TOCTOU pre-validation checks and corrupt the event log.

- **step_started**: Add `NOT IN ('completed','failed','cancelled')` guard (fixes the observed `CORRUPTED_EVENT_LOG` in webhook e2e test)
- **step_retrying**: Add terminal-state guard (was completely unguarded)
- **step_completed/step_failed**: Add `cancelled` to existing terminal-state guard
- **run_completed/run_failed/run_cancelled**: Add terminal-state guards (were completely unguarded)
- **isStepTerminal**: Add `cancelled` to the helper used in pre-validation
