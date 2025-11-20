---
'@workflow/ai': patch
---

Fix DurableAgent to handle FatalError in tool calls. When a tool throws a FatalError, it is now converted to a tool error result that gets propagated back to the LLM instead of killing the entire workflow. This mimics AI SDK behavior where tool call failures are sent back to the model. Non-fatal errors are re-thrown to allow workflow retry mechanisms to handle them.
