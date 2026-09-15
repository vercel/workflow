/**
 * The replay check is only worth having if it fails when it should, so these
 * drive `verifyReplay` against handlers that deliberately re-derive the wrong
 * thing. The workflow runtime is stubbed out: what is under test here is the
 * comparison — given a committed log and a cold replay that disagrees with it,
 * is the disagreement reported and named correctly?
 */

import { getWorld } from '@workflow/core/runtime';
import {
  type Event,
  SPEC_VERSION_CURRENT,
  slotToEventId,
  type WorkflowRun,
} from '@workflow/world';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS } from './drive.js';
import { verifyReplay } from './replay.js';

const RUN = 'wrun_01HK153X00000000000105JM0S';
const WORKFLOW = 'workflow//./workflows/demo//demoWorkflow';
const AT = new Date('2024-01-01T00:00:00.000Z');
const OUTPUT = new Uint8Array([1, 2, 3]);

let counter = 0;
function event(partial: Partial<Event> & Pick<Event, 'eventType'>): Event {
  counter++;
  return {
    runId: RUN,
    eventId: slotToEventId(counter),
    createdAt: new Date(AT.getTime() + counter),
    specVersion: SPEC_VERSION_CURRENT,
    ...partial,
  } as Event;
}

function committedLog(): Event[] {
  return [
    event({
      eventType: 'run_created',
      eventData: {
        deploymentId: 'dpl_sim',
        workflowName: WORKFLOW,
        input: new Uint8Array(),
      },
    }),
    event({ eventType: 'run_started' }),
    event({ eventType: 'run_completed', eventData: { output: OUTPUT } }),
  ];
}

function completedRun(): WorkflowRun {
  return {
    runId: RUN,
    deploymentId: 'dpl_sim',
    workflowName: WORKFLOW,
    status: 'completed',
    output: OUTPUT,
    attributes: {},
    createdAt: AT,
    updatedAt: AT,
    startedAt: AT,
    completedAt: AT,
  } as WorkflowRun;
}

/** A stand-in for the runtime: writes whatever terminal event we tell it to. */
function handlerWriting(
  write: ((world: Awaited<ReturnType<typeof getWorld>>) => Promise<void>) | null
) {
  return async () => {
    if (write) await write(await getWorld());
    return Response.json({ ok: true });
  };
}

async function check(
  handler: (req: Request) => Promise<Response>,
  events = committedLog()
) {
  return verifyReplay({
    run: completedRun(),
    events,
    handler,
    limits: { ...DEFAULT_LIMITS, maxWallMs: 5_000 },
  });
}

const rules = (result: { violations: { rule: string }[] }) =>
  result.violations.map((v) => v.rule);

describe('replay verification', () => {
  it('passes when the replay re-derives the withheld terminal event', async () => {
    const result = await check(
      handlerWriting(async (world) => {
        await world.events.create(RUN, {
          eventType: 'run_completed',
          specVersion: SPEC_VERSION_CURRENT,
          eventData: { output: OUTPUT },
        });
      })
    );
    expect(result.violations).toEqual([]);
    expect(result.regenerated.map((e) => e.eventType)).toEqual([
      'run_completed',
    ]);
  });

  it('catches a replay that derives a different output', async () => {
    const result = await check(
      handlerWriting(async (world) => {
        await world.events.create(RUN, {
          eventType: 'run_completed',
          specVersion: SPEC_VERSION_CURRENT,
          eventData: { output: new Uint8Array([9, 9, 9]) },
        });
      })
    );
    expect(rules(result)).toContain('replay.output-differs');
  });

  it('catches a replay that reaches a different terminal state', async () => {
    const result = await check(
      handlerWriting(async (world) => {
        await world.events.create(RUN, {
          eventType: 'run_failed',
          specVersion: SPEC_VERSION_CURRENT,
          eventData: { error: new Uint8Array(), errorCode: 'USER_ERROR' },
        });
      })
    );
    expect(rules(result)).toContain('replay.status-differs');
    expect(rules(result)).toContain('replay.log-differs');
  });

  it('names a corrupted event log specifically', async () => {
    // What the runtime does when a replay cannot follow the history it wrote:
    // it exhausts its recovery replays and fails the run with this code.
    const result = await check(
      handlerWriting(async (world) => {
        await world.events.create(RUN, {
          eventType: 'run_failed',
          specVersion: SPEC_VERSION_CURRENT,
          eventData: {
            error: new Uint8Array(),
            errorCode: 'CORRUPTED_EVENT_LOG',
          },
        });
      })
    );
    expect(rules(result)).toEqual(['replay.diverged']);
    expect(result.violations[0].message).toMatch(
      /could not follow the history it wrote/
    );
  });

  it('catches a replay that runs out of log and suspends', async () => {
    // The handler acknowledges the delivery without finishing the run — the
    // shape of "the log did not contain enough to rebuild the run".
    const result = await check(handlerWriting(null));
    expect(rules(result)).toContain('replay.suspended');
  });

  it('re-derives nothing to compare when the run never terminated', async () => {
    const events = committedLog().slice(0, 2);
    const result = await check(handlerWriting(null), events);
    expect(result.violations).toEqual([]);
    expect(result.regenerated).toEqual([]);
  });
});
