import { createWebhook } from 'workflow';

async function processPayload(body: string) {
  'use step';
  return JSON.parse(body) as Record<string, unknown>;
}

export async function webhookWorkflow(endpointId: string) {
  'use workflow';

  // createWebhook() does not accept a token — tokens are randomly generated.
  // Use waitForHook() in tests to discover the token.
  using webhook = createWebhook();

  const request = await webhook;
  const body = await request.text();
  const parsed = await processPayload(body);

  return { endpointId, received: parsed };
}
