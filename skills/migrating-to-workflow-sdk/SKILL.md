---
name: migrating-to-workflow-sdk
description: Migrates Temporal, Inngest, Trigger.dev, and AWS Step Functions workflows to the Workflow SDK. Use when porting Activities, Workers, Signals, step.run(), step.waitForEvent(), Trigger.dev tasks / wait.forToken / triggerAndWait, ASL JSON state machines, Task/Choice/Wait/Parallel states, task tokens, or child workflows.
metadata:
  author: Vercel Inc.
  version: '0.2.0'
---

# Migrating to the Workflow SDK

Use this skill when converting an existing orchestration system to the Workflow SDK.

## Intake

1. Identify the source system:
   - Temporal
   - Inngest
   - Trigger.dev
   - AWS Step Functions
2. Identify the target runtime:
   - Managed hosting -> keep examples focused on `start()`, `getRun()`, hooks/webhooks, and route handlers.
   - Self-hosted -> also read `references/runtime-targets.md` and explicitly say the workflow/step code can stay the same, but deployment still needs a `World` implementation and startup bootstrap.
3. Extract the source constructs:
   - entrypoint
   - waits / timers
   - external callbacks / approvals
   - retries / failure handling
   - child workflows / fan-out
   - progress streaming
   - external side effects

## Default migration rules

- Put orchestration in `"use workflow"` functions.
- Put side effects, SDK calls, DB calls, HTTP calls, and stream I/O in `"use step"` functions.
- Use `sleep()` only in workflow context.
- For Signals, `step.waitForEvent()`, and `.waitForTaskToken`, choose exactly one resume surface:
  - `resume/internal` -> `createHook()` + `resumeHook()` when the app resumes from server-side code with a deterministic business token.
  - `resume/url/default` -> `createWebhook()` when the external system needs a generated callback URL and the default `202 Accepted` response is fine.
  - `resume/url/manual` -> `createWebhook({ respondWith: 'manual' })` only when the prompt explicitly requires a custom response body, status, or headers.
  - If a callback-URL prompt does not specify response semantics, default to `resume/url/default` and make the assumption explicit in `## Open Questions`.
- Never pair `createWebhook()` with `resumeHook()`, and never pass `token:` to `createWebhook()`.
- Wrap `start()` and `getRun()` inside `"use step"` functions for child runs.
- Use `getStepMetadata().stepId` as the idempotency key for external writes.
- Use `getWritable()` in workflow context to obtain the stream, but interact with it (write, close) only inside `"use step"` functions.
- Prefer rollback stacks for multi-step compensation.
- Choose app-boundary syntax in this order:
  1. If the prompt explicitly asks for framework-agnostic app-boundary code, use plain `Request` / `Response` even when a framework like Hono is named.
  2. Otherwise, if the target framework is named, shape app-boundary examples to that framework.
  3. Otherwise, keep examples framework-agnostic with `Request` / `Response`. Do not default to Next.js-only route signatures unless Next.js is explicitly named.

> Fast memory aid:
> - Callback URL + default ack -> `createWebhook()`
> - Callback URL + custom ack -> `createWebhook({ respondWith: 'manual' })`
> - Deterministic server-side resume -> `createHook()` + `resumeHook()`

## Fast-path router

Load `references/resume-routing.md` when the source pauses for Signals, `step.waitForEvent()`, or `.waitForTaskToken`.

Fast defaults:

- callback URL only -> `resume/url/default`
- callback URL + explicit custom response -> `resume/url/manual`
- deterministic server-side resume -> `resume/internal`
- self-hosted -> add `runtime/self-hosted`
- named framework -> add `boundary/named-framework`
- explicit framework-agnostic request -> add `boundary/framework-agnostic`

Before drafting `## Migrated Code`, write the selected route keys in `## Migration Plan`.

## Source references

- Temporal -> `references/temporal.md`
- Inngest -> `references/inngest.md`
- Trigger.dev -> `references/trigger-dev.md`
- AWS Step Functions -> `references/aws-step-functions.md`

## Shared references

- `references/shared-patterns.md` — reusable code templates for hooks, child workflows, idempotency, streaming, and rollback.
- `references/runtime-targets.md` — Managed vs custom `World` guidance.
- `references/resume-routing.md` — route-key selection, obligations, and exact `## Migration Plan` shape.
- `references/retries.md` — canonical retry mechanics: `stepFn.maxRetries`, `RetryableError({ retryAfter })`, `FatalError`.

## Required output shape

Return the migration in this structure:

```md
## Migration Plan
## Source -> Target Mapping
## Migrated Code
## App Boundary / Resume Endpoints
## Verification Checklist
## Open Questions
```

## Verification checklist

Fail the draft if any of these are true:

- [ ] `## Migration Plan` omits `Route keys`
- [ ] `## Migration Plan` omits `Why these route keys`
- [ ] `## Migration Plan` lists route keys that do not match the prompt
- [ ] `## Migration Plan` lists required code obligations that do not match the selected route keys
- [ ] Source-framework primitives remain in the migrated code
- [ ] Side effects remain in workflow context
- [ ] `sleep()` appears inside a step
- [ ] Stream interaction (`getWriter()`, `write()`, `close()`) appears inside a workflow function
- [ ] Child workflows call `start()` / `getRun()` directly from workflow context
- [ ] External writes omit idempotency keys
- [ ] Hooks/webhooks are missing where the source used signals, waitForEvent, or task tokens
- [ ] A callback-URL flow uses `createHook()` + `resumeHook()` instead of `createWebhook()`
- [ ] A `resume/url/default` or `resume/url/manual` migration invents a user-authored callback route or `resumeWebhook()` wrapper when `webhook.url` should be the only resume surface
- [ ] `createWebhook()` is given a custom `token` or paired with `resumeHook()`

Validation note:

- Reading webhook request data in workflow context is allowed. Only `request.respondWith()` is step-only.

Additional fail conditions:

- `resume/internal` output omits `resumeHook()` in app-boundary code
- `resume/internal` output omits a deterministic business token
- `resume/internal` output emits `createWebhook()` or `webhook.url`
- `resume/url/default` output does not pass `webhook.url` to the external system
- `resume/url/default` output emits `resumeHook()`, `respondWith: 'manual'`, or `RequestWithResponse` without a custom-response requirement in the prompt
- `resume/url/default` output invents a user-authored callback route or `resumeWebhook()` wrapper when `webhook.url` is the intended resume surface
- `resume/url/manual` output does not pass `webhook.url` to the external system
- `resume/url/manual` output omits `RequestWithResponse` or `await request.respondWith(...)`
- `resume/url/manual` output calls `request.respondWith(...)` outside a `"use step"` function
- `resume/url/manual` output invents a user-authored callback route or `resumeWebhook()` wrapper when `webhook.url` is the intended resume surface
- `createWebhook()` is paired with `resumeHook()`
- self-hosted output omits `World extends Queue, Streamer, Storage`, `startWorkflowWorld()`, or the explicit note that the workflow and step code can stay the same while the app still needs a custom `World`
- named-framework output mixes framework syntax with plain `Request` / `Response` app-boundary code without a framework-agnostic override

For concrete passing code, load:

- `references/shared-patterns.md` -> `## Generated callback URL (default response)`
- `references/shared-patterns.md` -> `## Generated callback URL (manual response)`
- `references/runtime-targets.md` -> `## Self-hosted output block`
- `references/aws-step-functions.md` -> `## Combined recipe: callback URL on self-hosted Hono`

## Sample prompt

```
Migrate this Inngest workflow to the Workflow SDK.
It uses step.waitForEvent() with a timeout and step.realtime.publish().
```

Expected response shape:

```md
## Migration Plan
## Source -> Target Mapping
## Migrated Code
## App Boundary / Resume Endpoints
## Verification Checklist
## Open Questions
```

## Example references

Load a worked example only when the prompt needs concrete code:

- `references/shared-patterns.md` -> `## Named-framework internal resume example (Hono)`
- `references/shared-patterns.md` -> `## Generated callback URL (default response)`
- `references/shared-patterns.md` -> `## Generated callback URL (manual response)`
- `references/runtime-targets.md` -> `## Self-hosted output block`
- `references/aws-step-functions.md` -> `## Combined recipe: callback URL on self-hosted Hono`

Reject these counterexamples:

- `resume/url/default` or `resume/url/manual` + user-authored callback route when `webhook.url` is the intended resume surface
- `createWebhook()` paired with `resumeHook()`
- named-framework app-boundary output mixed with plain `Request` / `Response` without a framework-agnostic override
