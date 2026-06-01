---
'@workflow/ai': patch
---

DurableAgent: recover from invalid tool-call input instead of aborting the stream

When a model emits a tool call whose arguments fail `inputSchema` validation (and no `experimental_repairToolCall` fixes it), `executeTool` now returns the validation error to the model as an `error-text` tool result — the same way tool *execution* errors are already handled — instead of throwing and aborting the whole agent stream. In a durable workflow that throw fails the entire run, so a single occasionally-malformed model tool-call could kill a long-running task with no chance for the agent to self-correct. The agent now sees the error as a tool result and can fix the arguments and retry within its step budget.
