---
"@workflow/core": patch
"workflow": patch
---

Remove `getReader()`, `values()` and `for await` on `response.body` inside workflow functions, added in 5.3.0. Read response bodies with `response.json()`, `response.text()` or `response.arrayBuffer()`, or make the request and process the response inside a step function. AI SDK calls belong in a step function or in AI SDK's `WorkflowAgent`, not behind `globalThis.fetch = fetch` in the workflow function.
