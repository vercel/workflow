---
"@workflow/world": minor
"@workflow/builders": minor
"@workflow/core": minor
"@workflow/world-local": minor
---

Add queue namespace primitive for framework isolation. When multiple frameworks (or a framework + direct SDK usage) share the same deployment, their workflow queue triggers can collide because both subscribe to `__wkf_workflow_*`. This change introduces an optional `namespace` parameter that scopes queue topic prefixes to `__{namespace}_wkf_workflow_*`, preventing cross-framework message misdelivery.

**New APIs:**
- `getQueueTopicPrefix(kind, namespace?)` in `@workflow/world` — builds namespaced queue prefixes
- `createWorkflowQueueTrigger({ namespace })` in `@workflow/builders` — trigger factory with optional namespace
- `workflowEntrypoint(code, { namespace })` in `@workflow/core` — namespace-aware workflow handler
- `getWorkflowQueueName(name, namespace)` in `@workflow/core` — namespace-aware queue name construction
- `healthCheck(world, endpoint, { namespace })` in `@workflow/core` — namespace-aware health checks

**Updated types:**
- `QueuePrefix` widened from `'__wkf_step_' | '__wkf_workflow_'` to regex-validated string accepting namespaced variants
- `ValidQueueName` widened to match
- `LocalQueue.registerHandler` accepts `QueuePrefix` instead of hardcoded literal union
- `getQueueRoute` in world-local uses regex matching for namespaced prefixes

**Backward compatible:** Default behavior (no namespace) is unchanged. `WORKFLOW_QUEUE_TRIGGER` remains the same. All existing queue name strings remain valid.
