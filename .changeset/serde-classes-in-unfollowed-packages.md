---
"@workflow/builders": patch
---

Register serialization classes from packages with no `workflow` dependency, such as AI SDK providers, in the step bundle. A model created inside a `"use workflow"` function and passed to a step (the `WorkflowAgent` shape) no longer fails with `Class "class//@ai-sdk/openai@…" not found`.
