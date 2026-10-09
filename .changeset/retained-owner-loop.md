---
"@workflow/core": minor
"@workflow/world-vercel": minor
---

Add an opt-in retained runner with an in-memory input mailbox, local hook and
idempotency state, serialized event persistence, and a bounded idle lifetime.
Conflicting events and persistence failures stop the runner and attempt to
durably fail the run before rejecting unfinished inputs. Diagnostic observations
identify owner turns, event persistence, step execution, and failure outcomes.
