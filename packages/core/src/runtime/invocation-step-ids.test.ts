import { describe, expect, it } from 'vitest';
import {
  attachInvocationStepIds,
  recordInvocationStepId,
  WORKFLOW_STEP_IDS_HEADER,
  withInvocationStepIds,
} from './invocation-step-ids.js';

describe('invocation step IDs', () => {
  it('reports unique step IDs in execution order', async () => {
    await withInvocationStepIds(async () => {
      recordInvocationStepId('step_a');
      recordInvocationStepId('step_b');
      recordInvocationStepId('step_a');

      const response = attachInvocationStepIds(new Response(null));

      expect(response.headers.get(WORKFLOW_STEP_IDS_HEADER)).toBe(
        JSON.stringify(['step_a', 'step_b'])
      );
    });
  });

  it('isolates concurrent invocations', async () => {
    const { promise: firstBlocked, resolve: releaseFirst } =
      Promise.withResolvers<void>();

    const first = withInvocationStepIds(async () => {
      recordInvocationStepId('step_first');
      await firstBlocked;
      return attachInvocationStepIds(new Response(null));
    });

    const second = withInvocationStepIds(async () => {
      recordInvocationStepId('step_second');
      return attachInvocationStepIds(new Response(null));
    });

    releaseFirst();
    const [firstResponse, secondResponse] = await Promise.all([first, second]);

    expect(firstResponse.headers.get(WORKFLOW_STEP_IDS_HEADER)).toBe(
      JSON.stringify(['step_first'])
    );
    expect(secondResponse.headers.get(WORKFLOW_STEP_IDS_HEADER)).toBe(
      JSON.stringify(['step_second'])
    );
  });
});
