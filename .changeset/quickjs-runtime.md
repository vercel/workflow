---
"@workflow/core": minor
---

Add an opt-in QuickJS WASM workflow runtime (`WORKFLOW_RUNTIME=quickjs`, or per-run `executionContext.workflowRuntime`) as an alternative to the default `node:vm` runtime. It executes workflow orchestrator code inside a QuickJS WASM VM via `quickjs-wasi`, enabling workflow execution on runtimes that disallow `node:vm` / code-generation-from-strings (e.g. Cloudflare Workers). The default runtime is unchanged.
