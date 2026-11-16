---
'@workflow/cli': minor
---

Add `workflow migrate inngest`, a codemod that turns Inngest functions into `"use workflow"` functions and lifts each `step.run()` closure into a `"use step"` function whose parameters are the variables it captured. It also maps `step.sleep()`, `step.sleepUntil()`, `step.waitForEvent()` and `step.waitForSignal()` (to hooks that are disposed when the wait ends), `step.invoke()`, `step.fetch()`, `step.ai.wrap()`, `retries`, `NonRetriableError` and `RetryAfterError`. It leaves a `TODO(workflow-migrate)` comment wherever a change needs a decision, and reports each lifted step's captured variables, an event routing table, and the `inngest.send()` calls to replace. It reads the project's tsconfig and uses the project's TypeScript, an optional peer dependency.
