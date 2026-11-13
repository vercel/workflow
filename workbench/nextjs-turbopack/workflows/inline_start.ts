import { createHook, getStepMetadata } from 'workflow';

/**
 * Fixtures for inline orchestrator delivery from `start()` / `resumeHook()` (see
 * `app/api/inline-start/route.ts` and packages/core/e2e/e2e-inline-start.test.ts).
 *
 * Every step reports the process it ran in (`processInstanceId`): an inline
 * delivery runs in the API route's process, so its steps report the same ID
 * the route answered with, while a queued one runs in the flow route's.
 */

const INSTANCE = Symbol.for('workbench/inline-start/instance');

/** A random ID for this process, shared by the route and the steps it runs. */
export function processInstanceId(): string {
  const g = globalThis as typeof globalThis & { [INSTANCE]?: string };
  g[INSTANCE] ??= crypto.randomUUID();
  return g[INSTANCE];
}

interface StepReport {
  at: number;
  attempt: number;
  instance: string;
}

async function timedStep(
  label: string
): Promise<StepReport & { label: string }> {
  'use step';
  return {
    label,
    at: Date.now(),
    attempt: getStepMetadata().attempt,
    instance: processInstanceId(),
  };
}

/** Two steps: time to the first one, and to completion. */
export async function inlineTimingWorkflow(startCalledAt: number) {
  'use workflow';
  const first = await timedStep('first');
  const second = await timedStep('second');
  return { startCalledAt, steps: [first, second] };
}

/** Waits on a hook, then runs one step: the resume's inline delivery runs it. */
export async function inlineHookWorkflow(token: string) {
  'use workflow';
  const before = await timedStep('before-hook');
  const hook = createHook<{ resumedAt: number }>({ token });
  const { resumedAt } = await hook;
  const after = await timedStep('after-hook');
  return { resumedAt, steps: [before, after] };
}
