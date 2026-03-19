---
'@workflow/core': patch
---

Fix workflow/step not found errors to fail gracefully instead of causing infinite queue retries.

- **Step not found**: Now fails the step (not the run) and re-queues the workflow, allowing the workflow to handle the error gracefully via try/catch - matching the FatalError pattern.
- **Workflow not found**: Now throws `WorkflowRuntimeError` instead of `ReferenceError`, which is properly caught and fails the run instead of bubbling up to the queue.

Both cases indicate code deployment mismatches that retries won't fix.
