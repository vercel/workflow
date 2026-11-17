import { bootId } from '@/lib/bundling-probe/clock';

/** Bundling probe (see `app/api/bp/*`): a workflow with two trivial steps. */
async function probeStep(label: string) {
  'use step';
  return {
    label,
    at: Date.now(),
    bootId: bootId(),
    uptimeMs: Math.round(process.uptime() * 1000),
  };
}

export async function lightProbeWorkflow(startCalledAt: number) {
  'use workflow';
  const first = await probeStep('first');
  const second = await probeStep('second');
  return { startCalledAt, steps: [first, second] };
}
