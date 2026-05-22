/**
 * Durable Objects — Hook-based method dispatch demo.
 *
 * Models a long-lived stateful counter as a workflow.
 * Each "method call" arrives as a hook; the workflow applies
 * the operation and loops for the next one.
 */

import { createHook } from 'workflow';

async function recordState(count: number) {
  'use step';
  return count;
}

export async function durableCounter(maxOps: number) {
  'use workflow';

  let count = 0;
  let ops = 0;

  while (ops < maxOps) {
    using hook = createHook<{
      type: 'increment' | 'decrement' | 'get';
      amount?: number;
    }>({ token: `counter:op-${ops}` });

    const action = await hook;
    ops++;

    switch (action.type) {
      case 'increment':
        count += action.amount ?? 1;
        break;
      case 'decrement':
        count -= action.amount ?? 1;
        break;
      case 'get':
        // no-op on state, just record current value
        break;
    }

    await recordState(count);
  }

  return { finalCount: count, totalOps: ops };
}
