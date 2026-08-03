# Shared migration patterns

## Core rules

- Orchestration -> `"use workflow"`
- Side effects, SDK access, DB access, stream I/O -> `"use step"`
- `sleep()` only in workflow context
- `getWritable()` obtainable in workflow, but interact with stream only in step context
- External side effects -> `getStepMetadata().stepId` as idempotency key
- Child workflows -> step-wrapped `start()` / `getRun()`

## Choosing hook vs webhook

Choose exactly one resume surface for Signals, `step.waitForEvent()`, and `.waitForTaskToken`.

Use `createHook()` + `resumeHook()` when:
- the app resumes the workflow from server-side code
- the resume point can be addressed with a deterministic business token such as `order:${orderId}:approval`

Use `createWebhook()` when:
- the external system needs a generated callback URL
- the migration needs raw `Request` handling inside the workflow
- the intended resume surface is the generated `webhook.url`
- the default `202 Accepted` response is fine

Use `createWebhook({ respondWith: 'manual' })` when:
- the external system still needs a generated callback URL
- the prompt explicitly requires a custom response body, status, or headers
- the migration needs `RequestWithResponse`
- `request.respondWith()` will run inside a `"use step"` function

Default to plain `createWebhook()` when the prompt only says "callback URL" and does not require a custom response.

Do not:
- pair `createWebhook()` with `resumeHook()`
- pass `token:` to `createWebhook()`
- invent a custom callback route when `webhook.url` is the intended resume surface

## Named-framework internal resume example (Hono)

Use this when the migration selected `resume/internal` and the prompt names Hono.

```ts
import { Hono } from 'hono';
import { resumeHook } from 'workflow/api';

const app = new Hono();

app.post('/api/orders/:orderId/approve', async (c) => {
  const orderId = c.req.param('orderId');
  const body = (await c.req.json()) as { approved: boolean };

  await resumeHook(`order:${orderId}:approval`, {
    approved: body.approved,
  });

  return c.json({ ok: true });
});

export default app;
```

**Sample input**

```md
Migrate an Inngest approval workflow to the Workflow SDK for Hono.
The app resumes approvals from server-side code with a deterministic token.
```

**Expected output**

- Uses `createHook()` in workflow code
- Uses Hono syntax for the `resumeHook()` endpoint
- Does not use `createWebhook()`
- Does not emit a plain `Request` / `Response` approval handler

## Deterministic server-side resume

```ts
import { createHook } from 'workflow';
import { resumeHook } from 'workflow/api';

export async function approvalWorkflow(orderId: string) {
  'use workflow';

  using approval = createHook<{ approved: boolean }>({
    token: `order:${orderId}:approval`,
  });

  return await approval;
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

## Generated callback URL (default response)

Use this when the external system needs a callback URL and the default `202 Accepted` response is fine.

```ts
import { createWebhook } from 'workflow';

type VerificationCallback = {
  approved: boolean;
  reviewer?: string;
};

export async function verificationWorkflow(documentId: string) {
  'use workflow';

  using webhook = createWebhook();

  await submitForVerification(documentId, webhook.url);
  const request = await webhook;
  const payload = (await request.json()) as VerificationCallback;

  return payload.approved
    ? { status: 'verified' as const, reviewer: payload.reviewer }
    : { status: 'rejected' as const, reviewer: payload.reviewer };
}

async function submitForVerification(
  documentId: string,
  callbackUrl: string,
): Promise<void> {
  'use step';

  await fetch(process.env.VENDOR_VERIFY_URL!, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ documentId, callbackUrl }),
  });
}
```

## Generated callback URL (manual response)

Use this when the external system needs a callback URL and the migration must send a custom HTTP response.

```ts
import { createWebhook, type RequestWithResponse } from 'workflow';

type VerificationCallback = {
  approved: boolean;
  reviewer?: string;
};

export async function verificationWorkflow(documentId: string) {
  'use workflow';

  using webhook = createWebhook({ respondWith: 'manual' });

  await submitForVerification(documentId, webhook.url);
  const request = await webhook;
  const payload = (await request.json()) as VerificationCallback;

  await acknowledgeVerification(request, payload.approved);

  return payload.approved
    ? { status: 'verified' as const, reviewer: payload.reviewer }
    : { status: 'rejected' as const, reviewer: payload.reviewer };
}

async function submitForVerification(
  documentId: string,
  callbackUrl: string,
): Promise<void> {
  'use step';

  await fetch(process.env.VENDOR_VERIFY_URL!, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ documentId, callbackUrl }),
  });
}

async function acknowledgeVerification(
  request: RequestWithResponse,
  approved: boolean,
): Promise<void> {
  'use step';

  await request.respondWith(
    Response.json({ ok: true, approved }),
  );
}
```

Rules:

- Prefer the default-response version when the prompt only asks for a callback URL.
- Only use manual-response mode when the prompt requires a custom response body, status, or headers.
- Reading webhook request data may happen in workflow or step context. `request.respondWith()` is the step-only operation.

Expected behavior:

- Sample input: `Vendor needs a callback URL.` → Expected pattern: `createWebhook()` with no `RequestWithResponse`.
- Sample input: `Vendor needs a callback URL and a custom JSON ack body.` → Expected pattern: `createWebhook({ respondWith: 'manual' })` plus step-level `request.respondWith()`.

## Hook with timeout

```ts
import { createHook, sleep } from 'workflow';

type Approval = { approved: boolean };

export async function approvalWorkflow(id: string) {
  'use workflow';

  using approval = createHook<Approval>({
    token: `approval:${id}`,
  });

  const result = await Promise.race([
    approval.then((payload) => ({ kind: 'approval' as const, payload })),
    sleep('7d').then(() => ({ kind: 'timeout' as const })),
  ]);

  if (result.kind === 'timeout') {
    return { id, status: 'timed_out' as const };
  }

  return {
    id,
    status: result.payload.approved ? 'approved' : 'rejected',
  };
}
```

Resume endpoint (framework-agnostic):

```ts
import { resumeHook } from 'workflow/api';

export async function POST(request: Request) {
  const body = (await request.json()) as {
    id: string;
    approved: boolean;
  };

  await resumeHook(`approval:${body.id}`, {
    approved: body.approved,
  });

  return Response.json({ ok: true });
}
```

## Child workflow via step-wrapped start/getRun

```ts
import { getRun, start } from 'workflow/api';

export async function childWorkflow(input: string) {
  'use workflow';
  return await doWork(input);
}

async function doWork(input: string) {
  'use step';
  return { input, status: 'done' as const };
}

async function spawnChild(input: string): Promise<string> {
  'use step';
  const run = await start(childWorkflow, [input]);
  return run.runId;
}

async function collectChild(runId: string) {
  'use step';
  const run = getRun(runId);
  return (await run.returnValue) as { input: string; status: 'done' };
}
```

## Idempotent external write

```ts
import { getStepMetadata } from 'workflow';

async function writeOrder(orderId: string) {
  'use step';

  const { stepId } = getStepMetadata();

  await fetch(process.env.ORDER_API_URL!, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': stepId,
    },
    body: JSON.stringify({ orderId }),
  });
}
```

## Streaming boundary: obtain in workflow, interact in step

Use:

```ts
import { getWritable } from 'workflow';

export async function refundWorkflow(refundId: string) {
  'use workflow';

  const writable = getWritable<{ stage: string }>();
  await emitStatus(writable, { stage: 'requested' });
  await emitStatus(writable, { stage: 'completed' });
  return { refundId, status: 'done' as const };
}

async function emitStatus(
  writable: WritableStream<{ stage: string }>,
  chunk: { stage: string },
): Promise<void> {
  'use step';

  const writer = writable.getWriter();
  try {
    await writer.write(chunk);
  } finally {
    writer.releaseLock();
  }
}
```

Avoid:

```ts
import { getWritable } from 'workflow';

export async function badWorkflow() {
  'use workflow';

  const writable = getWritable<{ stage: string }>();
  const writer = writable.getWriter(); // ❌ stream interaction in workflow context
  await writer.write({ stage: 'requested' });
}
```

**Sample input:** `Migrate an Inngest workflow that publishes progress and waits for approval.`

**Expected output:** The migration may obtain `getWritable()` in workflow context, but every `getWriter()`, `write()`, and `close()` call remains inside a `"use step"` function.

> Obtaining `getWritable()` inside a step is also valid and is often cleaner for step-local publishing. The only hard rule is that `getWriter()`, `write()`, and `close()` never run directly in workflow context.

## Rollback stack

```ts
export async function orderSaga(orderId: string) {
  'use workflow';

  const rollbacks: Array<() => Promise<void>> = [];

  try {
    const reservation = await reserveInventory(orderId);
    rollbacks.push(() => releaseInventory(reservation.id));

    const charge = await chargePayment(orderId);
    rollbacks.push(() => refundPayment(charge.id));

    return { orderId, status: 'completed' as const };
  } catch (error) {
    // Compensate in reverse order
    while (rollbacks.length > 0) {
      await rollbacks.pop()!();
    }
    throw error;
  }
}
```
