# inngest-step-run-captures

## Prompt

Migrate the following Inngest function to the Workflow SDK. You cannot run commands in this project.

```ts
import { inngest } from '../client';
import { db } from '../db';

export const syncContacts = inngest.createFunction(
  { id: 'sync-contacts', retries: 4, idempotency: 'event.data.accountId' },
  { event: 'crm/sync.requested' },
  async ({ event, step }) => {
    const contacts = await step.run('load-contacts', () =>
      db.contacts.list(event.data.accountId)
    );

    let synced = 0;
    for (const contact of contacts) {
      await step.run(`push-${contact.id}`, async () => {
        await db.remote.upsert(event.data.accountId, contact);
        synced++;
      });
    }

    return { synced };
  }
);
```

## Must include

- `"use workflow"`
- `"use step"`
- a step function for `load-contacts` that receives the event (or `accountId`) as an argument
- a step function for `push-${contact.id}` that receives `contact` and the account ID as arguments
- the count computed in the workflow (for example `synced++` after the step returns, or `synced = contacts.length`), not inside the step
- `maxRetries = 4` on the step functions
- `experimental_hook` with a token built from `accountId` in the app-boundary `start()` call

## Must not include

- `inngest.createFunction`
- `step.run`
- a step function that assigns to `synced`
- a step function that reads `event` or `contact` without receiving it as a parameter

## Expected excerpt

```ts
for (const contact of contacts) {
  await pushContact(event.data.accountId, contact);
  synced++;
}
```
