# Migration skill acceptance

A response passes only if it:

1. removes all source-framework API symbols from final migrated code
2. uses `"use workflow"` for orchestration
3. uses `"use step"` for side effects
4. keeps `sleep()` in workflow context only
5. may call `getWritable()` in workflow or step context, but keeps all stream interaction (`getWriter()`, `write()`, `close()`) in step context only
6. uses step-wrapped `start()` / `getRun()` for child workflows
7. adds `getStepMetadata().stepId` for external idempotent writes
8. adds hooks/webhooks when the source used signals, wait-for-event, or task tokens
9. stays framework-agnostic when the target framework is unspecified
10. does not claim managed execution when the prompt says the target is self-hosted
11. chooses plain `createWebhook()` for generated callback-URL flows unless the prompt explicitly requires a custom HTTP response; when manual mode is chosen, `request.respondWith()` stays in step context

## Sample input for manual check

> Migrate this Inngest workflow to the Workflow SDK. It publishes progress and waits for approval with a 7d timeout.

Expected passing excerpt:

```ts
import { createHook, getWritable, sleep } from 'workflow';

export async function refundWorkflow(refundId: string) {
  'use workflow';

  const writable = getWritable<{ stage: string }>();
  await emitStatus(writable, { stage: 'requested' });

  using approval = createHook<{ approved: boolean }>({
    token: `refund:${refundId}:approval`,
  });

  const result = await Promise.race([
    approval.then((payload) => ({ kind: 'approval' as const, payload })),
    sleep('7d').then(() => ({ kind: 'timeout' as const })),
  ]);

  return result.kind === 'timeout'
    ? { refundId, status: 'timed-out' as const }
    : {
        refundId,
        status: result.payload.approved
          ? ('approved' as const)
          : ('rejected' as const),
      };
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

**Expected outcome:** This should pass. `getWritable()` appearing in workflow context should not be treated as a failure. Only direct stream interaction in workflow context should fail.
