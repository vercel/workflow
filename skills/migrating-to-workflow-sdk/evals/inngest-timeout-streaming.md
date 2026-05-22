# inngest-timeout-streaming

## Prompt

Migrate the following Inngest workflow to the Workflow SDK.

```ts
import { inngest } from '../client';

export const refundWorkflow = inngest.createFunction(
  { id: 'refund-workflow' },
  { event: 'refund/requested' },
  async ({ event, step }) => {
    await step.realtime.publish('status', { stage: 'requested' });

    const approval = await step.waitForEvent('wait-for-approval', {
      event: 'refund/approved',
      match: 'data.refundId',
      timeout: '7d',
    });

    if (!approval) {
      return { refundId: event.data.refundId, status: 'timed-out' as const };
    }

    return { refundId: event.data.refundId, status: 'approved' as const };
  }
);
```

## Must include

- `"use workflow"`
- `Promise.race`
- `sleep('7d')`
- `createHook()`
- `getWritable()`

## Must not include

- `inngest.createFunction`
- `step.waitForEvent`
- `step.realtime.publish`
- `serve()`

## Expected excerpt

```ts
const result = await Promise.race([
  approval.then((payload) => ({ kind: 'approval' as const, payload })),
  sleep('7d').then(() => ({ kind: 'timeout' as const })),
]);
```
