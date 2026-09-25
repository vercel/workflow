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

      expect(
        JSON.parse(response.headers.get(WORKFLOW_STEP_IDS_HEADER)!)
      ).toEqual(['step_a', 'step_b']);
    });
  });

  it('isolates concurrent invocations', async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

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

    expect(
      JSON.parse(firstResponse.headers.get(WORKFLOW_STEP_IDS_HEADER)!)
    ).toEqual(['step_first']);
    expect(
      JSON.parse(secondResponse.headers.get(WORKFLOW_STEP_IDS_HEADER)!)
    ).toEqual(['step_second']);
  });
});
