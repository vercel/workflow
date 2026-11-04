---
"@workflow/core": patch
"workflow": patch
---

**Removed:** reading `response.body` with `getReader()`, `values()` or `for await` inside workflow functions (added in 5.3.0) throws again. Use `response.json()`, `response.text()` or `response.arrayBuffer()`, or make the request and read the response in a step function. If you assigned `globalThis.fetch = fetch` to run AI SDK calls in a workflow function, move those calls into a step function, or use AI SDK's `WorkflowAgent` for agents.
