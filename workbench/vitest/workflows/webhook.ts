import { createWebhook } from 'workflow';

async function processPayload(body: string) {
  'use step';
  return JSON.parse(body) as Record<string, unknown>;
}

export async function webhookWorkflow(endpointId: string) {
  'use workflow';

  using webhook = createWebhook({
    token: `webhook:${endpointId}`,
  });

  const request = await webhook;
  const body = await request.text();
  const parsed = await processPayload(body);

  return { endpointId, received: parsed };
}
