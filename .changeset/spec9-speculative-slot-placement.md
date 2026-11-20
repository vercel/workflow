---
'@workflow/core': patch
---

Fix spec 9 runs that failed with `CORRUPTED_EVENT_LOG` ("Workflow replay diverged …" or "has a hole at slot …"), or never completed, after the orchestrator ran ahead of its writes while the live event feed delivered one of those writes before its answer. The orchestrator then placed later speculative events at the wrong slots, where two events could share an id and one of them, a step's outcome among them, was dropped from the log the workflow consumed. Each position is now counted once, no two events share a slot, a step outcome still being written is taken in before any speculative one placed after it, and a committed event is never dropped in favour of a speculative one.
