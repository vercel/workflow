/**
 * A run-ahead outcome is written at the slot the in-band writer predicts, and
 * its payload is prepared for replay under that slot's event id. When another
 * writer appends while the step body runs, the outcome commits further up and
 * the predicted slot holds another entity's event. A later replay in the same
 * delivery must still hand every step its own result.
 *
 * Node engine only: the QuickJS engine hydrates payloads inside its own
 * runtime and never reads the delivery's replay payload cache, so the shape
 * this covers does not exist there.
 */
import type { Event } from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerStepFunction } from '../../private.js';
import { dehydrateStepReturnValue } from '../../serialization.js';
import {
  eventsOf,
  registerWorkflow,
  runResult,
  setupOrchestratorRun,
} from '../../test-support/orchestrator-harness.js';
import { setWorld } from '../world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

const TOKEN = 'run-ahead-payload-cache';
const STEPS = 6;
/** Out-of-band hook payloads appended while step 1's body runs. */
const OUT_OF_BAND = 4;

let onBody: ((index: number) => Promise<void>) | undefined;
registerStepFunction('rapc_step', async (index: number) => {
  await onBody?.(index);
  await new Promise((resolve) => setTimeout(resolve, 30));
  return { index };
});

// The hook is never read, so no boundary is sensitive to it and the
// orchestrator runs ahead of its writes.
const workflowCode = `const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
const step = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("rapc_step");
async function workflow(steps) {
  const hook = createHook({ token: ${JSON.stringify(TOKEN)} });
  const seen = [];
  for (let i = 0; i < steps; i++) {
    const result = await step(i);
    if (result.index !== i) {
      throw new Error("step " + i + " replayed the result of step " + result.index);
    }
    seen.push(result.index);
  }
  hook.dispose();
  return seen;
}${registerWorkflow()}`;

afterEach(() => {
  setWorld(undefined);
  vi.unstubAllEnvs();
  onBody = undefined;
});

describe('run-ahead outcome committed above its predicted slot (node engine)', () => {
  it.each([
    ['retained VM', '1'],
    ['a cold replay per pass', '0'],
  ])(
    'hands every step its own result on replay, with %s',
    async (_label, retained) => {
      vi.stubEnv('WORKFLOW_ORCHESTRATOR_POLL_INTERVAL_MS', '0');
      vi.stubEnv('WORKFLOW_RETAINED_VM', retained);
      // A write round trip longer than several step bodies, so the
      // orchestrator runs more than one outcome ahead of the first commit.
      const { world, runId, start } = await setupOrchestratorRun(
        workflowCode,
        [STEPS],
        { createDelayMs: 200 },
        'node'
      );
      onBody = async (index) => {
        if (index !== 1) return;
        const hook = eventsOf(world, 'hook_created')[0];
        for (let k = 0; k < OUT_OF_BAND; k++) {
          world.appendOutOfBand({
            eventType: 'hook_received',
            runId,
            correlationId: hook?.correlationId,
            eventData: {
              token: TOKEN,
              payload: await dehydrateStepReturnValue(k, runId, undefined),
            },
          } as unknown as Partial<Event>);
        }
      };

      await world.deliver(start);
      await world.runUntilIdle();

      // Step 1's outcome committed above the out-of-band payloads, so the
      // slots run-ahead predicted for it and its successors held other events.
      const types = world.events.map((event) => event.eventType);
      const firstHook = types.indexOf('hook_received');
      const stepOneDone = world.events.findIndex(
        (event, index) =>
          index > firstHook && event.eventType === 'step_completed'
      );
      expect(eventsOf(world, 'hook_received')).toHaveLength(OUT_OF_BAND);
      expect(firstHook).toBeGreaterThan(0);
      expect(stepOneDone - firstHook).toBe(OUT_OF_BAND);
      expect(eventsOf(world, 'run_failed')).toEqual([]);
      expect(await runResult(world)).toEqual(
        Array.from({ length: STEPS }, (_, i) => i)
      );
    },
    30_000
  );
});
