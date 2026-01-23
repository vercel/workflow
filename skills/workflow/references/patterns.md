# Advanced Workflow Patterns

## Table of Contents
- [Hooks](#hooks)
- [Webhooks](#webhooks)
- [Control Flow](#control-flow)
- [Batching](#batching)
- [Streaming](#streaming)
- [Error Handling](#error-handling)
- [Real-World Examples](#real-world-examples)

## Hooks

### Basic Hook

```typescript
import { createHook } from "workflow";

export async function approvalWorkflow() {
  "use workflow";

  const hook = createHook<{ approved: boolean; comment: string }>();
  console.log("Send approval to:", hook.token);

  const result = await hook;  // Pauses until resumed
  return result.approved ? "Approved" : "Rejected";
}
```

### Custom Deterministic Tokens

Reconstruct tokens from external data:

```typescript
const hook = createHook<SlackMessage>({
  token: `slack:${channelId}:${threadTs}`
});

// External handler reconstructs token:
await resumeHook(`slack:${channelId}:${threadTs}`, slackEvent);
```

### Multiple Events (AsyncIterable)

```typescript
export async function dataCollectionWorkflow() {
  "use workflow";

  const hook = createHook<{ value: number; done?: boolean }>();
  const values: number[] = [];

  for await (const payload of hook) {
    values.push(payload.value);
    if (payload.done) break;
  }

  return { total: values.reduce((a, b) => a + b, 0), count: values.length };
}
```

### Type-Safe Hooks with Schema

```typescript
import { defineHook } from "workflow";
import { z } from "zod";

const approvalHook = defineHook({
  schema: z.object({
    requestId: z.string(),
    approved: z.boolean(),
    approvedBy: z.string(),
    comment: z.string().transform((v) => v.trim()),
  }),
});

export async function documentApproval(documentId: string) {
  "use workflow";

  const hook = approvalHook.create({ token: `approval:${documentId}` });
  const approval = await hook;

  return approval.approved;
}

// Resume with validation (throws on invalid data)
await approvalHook.resume(`approval:${documentId}`, approvalData);
```

Supported validators: Zod, Valibot, ArkType, Effect Schema

## Webhooks

### Basic Webhook

```typescript
import { createWebhook } from "workflow";

export async function paymentWorkflow(orderId: string) {
  "use workflow";

  const webhook = createWebhook();
  await notifyPaymentProvider(orderId, webhook.url);

  const request = await webhook;  // Pauses until HTTP POST
  const data = await request.json();

  if (data.status === "completed") {
    await fulfillOrder(orderId);
  }
}
```

### Manual Response Mode

```typescript
const webhook = createWebhook({ respondWith: "manual" });
const request = await webhook;

await processRequest(request);

// Must respond when using manual mode
await request.respondWith(new Response("OK", { status: 200 }));
```

### Automatic Custom Response

```typescript
const webhook = createWebhook({
  respondWith: new Response("Received", { status: 200 })
});
```

### Multiple Webhook Events

```typescript
for await (const request of webhook) {
  const data = await request.json();
  await processEvent(data);
  if (data.final) break;
}
```

### Hooks vs Webhooks

| Feature | Hooks | Webhooks |
|---------|-------|----------|
| Data format | Any serializable | HTTP Request |
| URL | Manual token | Auto `webhook.url` |
| Response | N/A | Auto or manual |
| Use case | Custom integrations | HTTP callbacks |

## Control Flow

### Parallel Steps (Promise.all)

```typescript
export async function parallelWorkflow(urls: string[]) {
  "use workflow";

  // Execute steps in parallel
  const results = await Promise.all(
    urls.map(url => fetchAndProcess(url))
  );

  return results;
}
```

### Race Condition (Promise.race)

First to complete wins - useful for timeouts or competitive execution:

```typescript
export async function raceWorkflow(taskId: string) {
  "use workflow";

  // Race between task completion and timeout
  const result = await Promise.race([
    (async () => {
      const data = await processTask(taskId);
      return { status: "completed", data };
    })(),
    (async () => {
      await sleep("30s");
      return { status: "timeout" };
    })(),
  ]);

  if (result.status === "timeout") {
    await notifyTimeout(taskId);
  }

  return result;
}
```

### Conditional Branching

```typescript
export async function conditionalWorkflow(userId: string) {
  "use workflow";

  const user = await getUser(userId);

  if (user.tier === "premium") {
    await processPremium(user);
  } else {
    await processStandard(user);
  }
}
```

### Polling Pattern

```typescript
export async function pollUntilReady(jobId: string) {
  "use workflow";

  while (true) {
    const status = await checkStatus(jobId);
    if (status === "ready") return await getResult(jobId);
    if (status === "failed") throw new FatalError("Job failed");
    await sleep("30s");
  }
}
```

### Retry with Backoff

```typescript
export async function retryWorkflow(data: any) {
  "use workflow";

  let attempts = 0;
  const maxAttempts = 5;

  while (attempts < maxAttempts) {
    try {
      return await processData(data);
    } catch (error) {
      attempts++;
      if (attempts >= maxAttempts) throw error;
      await sleep(`${Math.pow(2, attempts)}s`);  // Exponential backoff
    }
  }
}
```

## Batching

### Item-Level Steps (Granular Retry)

Each item in array is a separate step - if one fails, only that item retries:

```typescript
export async function itemLevelBatch(items: string[]) {
  "use workflow";

  const results = await Promise.all(
    items.map(async (item) => {
      return await processItem(item);  // Each is a separate step
    })
  );

  return results;
}

async function processItem(item: string) {
  "use step";
  // If this fails, only this item retries
  return await externalAPI.process(item);
}
```

### Batch-Level Steps (Atomic Retry)

Entire batch is one step - if any item fails, whole batch retries:

```typescript
export async function batchLevelWorkflow(items: string[]) {
  "use workflow";

  const results = await processBatch(items);
  return results;
}

async function processBatch(items: string[]) {
  "use step";
  // If ANY item fails, entire batch retries
  return await Promise.all(
    items.map(item => externalAPI.process(item))
  );
}
```

### Chunked Batching

Process large arrays in smaller chunks:

```typescript
export async function chunkedWorkflow(items: string[]) {
  "use workflow";

  const chunkSize = 10;
  const results: any[] = [];

  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize);
    const chunkResults = await processChunk(chunk);
    results.push(...chunkResults);
  }

  return results;
}

async function processChunk(chunk: string[]) {
  "use step";
  return await Promise.all(chunk.map(item => process(item)));
}
```

## Streaming

### Namespaced Streams

```typescript
async function processWithLogs(data: any) {
  "use step";

  const logsWriter = getWritable({ namespace: "logs" });
  const metricsWriter = getWritable({ namespace: "metrics" });

  await logsWriter.write({ level: "info", msg: "Starting" });
  await metricsWriter.write({ event: "start", timestamp: Date.now() });

  const result = await process(data);

  await logsWriter.write({ level: "info", msg: "Done" });
  logsWriter.releaseLock();
  metricsWriter.releaseLock();

  return result;
}
```

### Binary Data

```typescript
async function writeBinary(data: string) {
  "use step";

  const writer = getWritable();
  const encoder = new TextEncoder();
  await writer.write(encoder.encode(data));
  writer.releaseLock();
}
```

## Error Handling

### Categorizing Errors

```typescript
async function callExternalAPI(url: string) {
  "use step";

  const res = await fetch(url);

  // Permanent failures
  if (res.status === 401 || res.status === 403) {
    throw new FatalError(`Auth error: ${res.status}`);
  }

  // Retryable with delay
  if (res.status === 429) {
    const retryAfter = res.headers.get("Retry-After");
    throw new RetryableError("Rate limited", {
      retryAfter: retryAfter ? parseInt(retryAfter) * 1000 : "5m"
    });
  }

  // Server errors - auto retry
  if (res.status >= 500) {
    throw new Error(`Server error: ${res.status}`);
  }

  return res;
}
```

### Workflow-Level Error Handling

```typescript
export async function resilientWorkflow(input: any) {
  "use workflow";

  try {
    const result = await riskyOperation(input);
    return { success: true, result };
  } catch (error) {
    await notifyAdmin(error);
    await cleanup(input);
    return { success: false, error: error.message };
  }
}
```

## Real-World Examples

### Onboarding Drip Campaign

```typescript
export async function userOnboarding(email: string) {
  "use workflow";

  await sendWelcomeEmail(email);
  await sleep("3 days");
  await sendTipsEmail(email);
  await sleep("7 days");
  await sendFeedbackRequest(email);
}
```

### Churn Prevention

```typescript
export async function churnPrevention(userId: string) {
  "use workflow";

  await sleep("7 days");
  if (!await isActive(userId)) {
    await sendReEngagementEmail(userId);
    await sleep("3 days");
    if (!await isActive(userId)) {
      await offerDiscount(userId);
    }
  }
}
```

### Order Processing

```typescript
export async function processOrder(orderId: string) {
  "use workflow";

  const payment = await chargeCard(orderId);

  // Wait for warehouse webhook
  const webhook = createWebhook();
  await notifyWarehouse(orderId, webhook.url);
  const shipment = await webhook;

  await notifyCustomer(orderId, await shipment.json());
  return { orderId, status: "shipped" };
}
```

### Multi-Step Approval

```typescript
export async function multiApproval(requestId: string) {
  "use workflow";

  const managers = await getApprovers(requestId);

  for (const manager of managers) {
    const hook = createHook<{ approved: boolean }>();
    await notifyManager(manager, requestId, hook.token);

    const decision = await hook;
    if (!decision.approved) {
      return { status: "rejected", rejectedBy: manager };
    }
  }

  await executeRequest(requestId);
  return { status: "approved" };
}
```
