import { createWebhook } from 'workflow';

async function processPayload(body: string): Promise<{ event: string }> {
  'use step';
  const parsed = JSON.parse(body);
  return { event: parsed.event ?? 'unknown' };
}

export async function webhooksWorkflow(orderId: string) {
  'use workflow';

  using webhook = createWebhook();

  const request = await webhook;
  const body = await request.text();
  const result = await processPayload(body);

  return { orderId, event: result.event };
}
