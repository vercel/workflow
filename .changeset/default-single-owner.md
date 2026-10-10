---
"@workflow/core": patch
"@workflow/world-vercel": patch
---

Make runs single-owner by default where the deployment can host their owner: `start()` adds the `$experimentalSingleOwner` marker (`{}`, routed by run ID) unless the caller passed one. The retained runner is always on where invocation is configured (no `WORKFLOW_RETAINED_RUNNER`); world-vercel invokes this deployment's generated route by default, accepts a bare origin in `WORKFLOW_VERCEL_INVOKE_URL`, and sends `VERCEL_WORKFLOW_SERVER_BYPASS` to an overridden workflow-server. Step placement (three local bodies, direct overflow) is implied; the `experimental_stepExecution` option is removed.
