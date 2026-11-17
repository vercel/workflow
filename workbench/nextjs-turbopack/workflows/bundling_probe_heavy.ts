import { bootId } from '@/lib/bundling-probe/clock';
import { makeClients } from '@/lib/bundling-probe/heavy-deps';

/**
 * Bundling probe (see `app/api/bp/*`): a workflow whose steps import heavy
 * SDKs (AWS S3, Slack, OpenAI, Stripe), as a realistic app's do.
 */
async function heavyStep(label: string) {
  'use step';
  return {
    label,
    at: Date.now(),
    bootId: bootId(),
    uptimeMs: Math.round(process.uptime() * 1000),
    clients: makeClients(),
  };
}

export async function heavyProbeWorkflow(startCalledAt: number) {
  'use workflow';
  const first = await heavyStep('first');
  const second = await heavyStep('second');
  return { startCalledAt, steps: [first, second] };
}
