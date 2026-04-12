# AWS Step Functions -> Workflow SDK

## Map these constructs

| AWS Step Functions | Workflow SDK |
| --- | --- |
| ASL JSON state machine | `"use workflow"` function |
| Task / Lambda | `"use step"` |
| Choice | `if` / `else` / `switch` |
| Wait | `sleep()` |
| Parallel | `Promise.all()` |
| Map | loop or `Promise.all()` |
| Retry / Catch | step retries + `try` / `catch`, `RetryableError`, `FatalError`, `maxRetries` |
| `.waitForTaskToken` | `createHook()` or `createWebhook()` |
| `StartExecution` (child state machine) | step-wrapped `start()` / `getRun()` |

## Remove

- ASL JSON state machine definitions from final migrated code
- Separate Lambda function stubs that only served as Task state handlers
- Task-token plumbing (`SendTaskSuccess`, `SendTaskFailure`, SQS queue setup) after converting to hooks/webhooks
- IAM roles and CloudFormation/CDK resources for orchestrator-to-Lambda wiring
- `"Next"` / `"End"` transition logic — replaced by `await` and `return`

## Add

- Resume surface for `.waitForTaskToken`:
  - Use `createHook()` + `resumeHook()` when the app resumes the workflow from server-side code with a deterministic business token.
  - Use `createWebhook()` when the external system needs a generated callback URL or the migrated flow should receive a raw `Request`, and the default `202 Accepted` response is fine.
  - Use `createWebhook({ respondWith: 'manual' })` only when the prompt explicitly requires a custom response body, status, or headers.
  - Choose exactly one surface. Do not pair `createWebhook()` with `resumeHook()`.
  - See `references/shared-patterns.md` -> `## Deterministic server-side resume`
  - See `references/shared-patterns.md` -> `## Generated callback URL (default response)`
  - See `references/shared-patterns.md` -> `## Generated callback URL (manual response)`
- Explicit `Promise.all()` for parallel work (replaces Parallel state)
- Loops or `Promise.all()` over arrays for Map state equivalents
- Rollback stack when the original graph used compensation chains (Catch → compensation states)
- Idempotency keys on external writes via `getStepMetadata().stepId`
- `getWritable()` for progress streaming (Step Functions has no built-in equivalent)
- Step-wrapped `start()` / `getRun()` for child workflows (replaces `StartExecution`)

## `.waitForTaskToken` fast paths

### Deterministic server-side resume

Use this when your app receives the approval in server-side code and can reconstruct a business token.

```ts
import { createHook } from 'workflow';
import { resumeHook } from 'workflow/api';

export async function approvalWorkflow(orderId: string) {
  'use workflow';
  using approval = createHook<{ approved: boolean }>({
    token: `order:${orderId}:approval`,
  });
  const { approved } = await approval;
  return {
    orderId,
    status: approved ? ('approved' as const) : ('rejected' as const),
  };
}

export async function POST(request: Request) {
  const body = (await request.json()) as {
    orderId: string;
    approved: boolean;
  };
  await resumeHook(`order:${body.orderId}:approval`, {
    approved: body.approved,
  });
  return Response.json({ ok: true });
}
```

### Generated callback URL (default `202 Accepted`)

Use this when the external system needs a callback URL and the default `202 Accepted` response is fine.

```ts
import { createWebhook } from 'workflow';

type ApprovalPayload = { approved: boolean };

export async function approvalWorkflow(orderId: string) {
  'use workflow';
  using approval = createWebhook();
  await sendApprovalRequest(orderId, approval.url);
  const request = await approval;
  const body = (await request.json()) as ApprovalPayload;
  return {
    orderId,
    status: body.approved ? ('approved' as const) : ('rejected' as const),
  };
}

async function sendApprovalRequest(
  orderId: string,
  callbackUrl: string,
): Promise<void> {
  'use step';
  await fetch(process.env.APPROVAL_API_URL!, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId, callbackUrl }),
  });
}
```

### Generated callback URL (manual response)

Use this when the external system needs a callback URL and the migrated flow must send a custom HTTP response.

```ts
import { createWebhook, type RequestWithResponse } from 'workflow';

type ApprovalPayload = { approved: boolean };

export async function approvalWorkflow(orderId: string) {
  'use workflow';
  using approval = createWebhook({ respondWith: 'manual' });
  await sendApprovalRequest(orderId, approval.url);
  const request = await approval;
  const body = (await request.json()) as ApprovalPayload;
  await acknowledgeApproval(request, body.approved);
  return {
    orderId,
    status: body.approved ? ('approved' as const) : ('rejected' as const),
  };
}

async function sendApprovalRequest(
  orderId: string,
  callbackUrl: string,
): Promise<void> {
  'use step';
  await fetch(process.env.APPROVAL_API_URL!, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId, callbackUrl }),
  });
}

async function acknowledgeApproval(
  request: RequestWithResponse,
  approved: boolean,
): Promise<void> {
  'use step';
  await request.respondWith(
    Response.json({ ok: true, approved }),
  );
}
```

Choose exactly one of these paths. Do not combine them in the same migration.

## Combined recipe: callback URL on self-hosted Hono

Use this when all of the following are true:

- the Step Functions source used `.waitForTaskToken`
- the external system needs a callback URL
- the target is self-hosted
- the prompt names Hono
- the prompt does not require a custom callback response

Workflow code:

```ts
import { createWebhook } from 'workflow';

type ApprovalPayload = { approved: boolean };

export async function refundWorkflow(refundId: string) {
  'use workflow';
  using approval = createWebhook();
  await sendApprovalRequest(refundId, approval.url);
  const request = await approval;
  const payload = (await request.json()) as ApprovalPayload;
  return {
    refundId,
    status: payload.approved ? ('approved' as const) : ('rejected' as const),
  };
}

async function sendApprovalRequest(
  refundId: string,
  callbackUrl: string,
): Promise<void> {
  'use step';
  await fetch(process.env.APPROVAL_API_URL!, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refundId, callbackUrl }),
  });
}
```

Self-hosted runtime requirements:

```ts
interface World extends Storage, Queue, Streamer {
  start?(): Promise<void>;
}
```

```ts
import { getWorld } from 'workflow/runtime';

export async function startWorkflowWorld(): Promise<void> {
  await getWorld().start?.();
}
```

Hono app boundary:

```ts
import { Hono } from 'hono';
import { start } from 'workflow/api';
import { refundWorkflow } from '../workflows/refund';

const app = new Hono();

app.post('/api/refunds/start', async (c) => {
  const body = (await c.req.json()) as { refundId: string };
  const run = await start(refundWorkflow, [body.refundId]);
  return c.json({ runId: run.runId });
});

export default app;
```

Required explanation: The workflow and step code can stay the same. Because this target is self-hosted, the app still needs a `World` implementation for storage, queueing, and streaming, plus a startup path that calls `await getWorld().start?.()` when the selected world runs background workers.

Must not appear:

```ts
resumeHook(...)
respondWith: 'manual'
RequestWithResponse
```

Sample prompt and expected shape:

- Input: `Migrate this Step Functions flow to the Workflow SDK for Hono on self-hosted Postgres. The vendor needs a callback URL. Default 202 is fine.`
- Expected route keys: `resume/url/default`, `runtime/self-hosted`, `boundary/named-framework`
