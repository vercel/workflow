# temporal-signal-child-run

## Prompt

Migrate the following Temporal workflow to the Workflow SDK. Keep the business behavior the same.

```ts
import * as wf from '@temporalio/workflow';
import type * as activities from '../activities/order';

const { loadOrder, chargeCard } = wf.proxyActivities<typeof activities>({
  startToCloseTimeout: '5 minute',
});

export const approveOrder = wf.defineSignal<[boolean]>('approveOrder');

export async function orderWorkflow(orderId: string) {
  let approved: boolean | undefined;

  wf.setHandler(approveOrder, (value) => {
    approved = value;
  });

  const order = await loadOrder(orderId);

  await wf.condition(() => approved !== undefined);

  if (!approved) {
    return { orderId, status: 'rejected' as const };
  }

  const result = await chargeCard(order.id);
  return { orderId, chargeId: result.id, status: 'completed' as const };
}
```

## Must include

- `"use workflow"`
- `"use step"`
- `createHook()`
- `resumeHook()`
- `getStepMetadata().stepId`

## Must not include

- `proxyActivities`
- `defineSignal`
- `wf.condition`
- Worker or Task Queue code

## Expected excerpt

```ts
using approval = createHook<{ approved: boolean }>({
  token: `order:${orderId}:approval`,
});
```
