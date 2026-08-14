import {
  type Event,
  type Step,
  slotToEventId,
  type WorkflowRun,
} from '@workflow/world';
import { describe, expect, it } from 'vitest';
import { checkInvariants, type InvariantInput } from './invariants.js';

/**
 * Most cases here do not care about the commit-order/log-order distinction, so
 * they pass one array and get it used for both. The cases that do care pass
 * `eventsInCommitOrder` explicitly.
 */
function check(
  input: Omit<InvariantInput, 'eventsInCommitOrder'> &
    Partial<Pick<InvariantInput, 'eventsInCommitOrder'>>
) {
  return checkInvariants({
    eventsInCommitOrder: input.events,
    ...input,
  });
}

const RUN = 'wrun_01HK153X00000000000105JM0S';
const BASE = new Date('2024-01-01T00:00:00.000Z');

let counter = 0;
function event(partial: Partial<Event> & Pick<Event, 'eventType'>): Event {
  counter++;
  return {
    runId: RUN,
    eventId: slotToEventId(counter),
    createdAt: new Date(BASE.getTime() + counter),
    specVersion: 5,
    ...partial,
  } as Event;
}

function run(status: WorkflowRun['status']): WorkflowRun {
  return {
    runId: RUN,
    deploymentId: 'dpl_sim',
    workflowName: 'workflow//./w//demo',
    status,
    attributes: {},
    createdAt: BASE,
    updatedAt: BASE,
    ...(status === 'completed' || status === 'failed' || status === 'cancelled'
      ? { completedAt: BASE }
      : {}),
    ...(status === 'completed' ? { output: new Uint8Array() } : {}),
    ...(status === 'failed' ? { error: new Uint8Array() } : {}),
  } as WorkflowRun;
}

const rules = (violations: { rule: string }[]) => violations.map((v) => v.rule);

describe('invariants', () => {
  it('accepts a well-formed run', () => {
    const events = [
      event({
        eventType: 'run_created',
        eventData: {
          deploymentId: 'd',
          workflowName: 'w',
          input: new Uint8Array(),
        },
      }),
      event({ eventType: 'run_started' }),
      event({
        eventType: 'step_created',
        correlationId: 's1',
        eventData: { stepName: 'step//./w//a', input: new Uint8Array() },
      }),
      event({ eventType: 'step_started', correlationId: 's1' }),
      event({
        eventType: 'step_completed',
        correlationId: 's1',
        eventData: { result: new Uint8Array() },
      }),
      event({
        eventType: 'run_completed',
        eventData: { output: new Uint8Array() },
      }),
    ];
    const steps: Step[] = [
      {
        runId: RUN,
        stepId: 's1',
        stepName: 'step//./w//a',
        status: 'completed',
        attempt: 1,
        createdAt: BASE,
        updatedAt: BASE,
      },
    ];
    expect(
      check({
        runId: RUN,
        events,
        runs: [run('completed')],
        steps,
        waits: [],
      })
    ).toEqual([]);
  });

  it('catches a log that gained a row behind a committed peer', () => {
    // Log order is fine; commit order is not. `b` took a position above `a`
    // and then `a` committed into the gap — the shape an append-only log
    // promises cannot happen.
    const a = event({
      eventType: 'run_created',
      eventData: {
        deploymentId: 'd',
        workflowName: 'w',
        input: new Uint8Array(),
      },
    });
    const b = event({ eventType: 'run_started' });
    expect(
      rules(
        check({
          runId: RUN,
          events: [a, b],
          eventsInCommitOrder: [b, a],
          runs: [run('running')],
          steps: [],
          waits: [],
        })
      )
    ).toContain('log.monotonic-order');
  });

  it('skips the order rule when the world makes no such promise', () => {
    const a = event({
      eventType: 'run_created',
      eventData: {
        deploymentId: 'd',
        workflowName: 'w',
        input: new Uint8Array(),
      },
    });
    const b = event({ eventType: 'run_started' });
    expect(
      rules(
        checkInvariants({
          runId: RUN,
          events: [a, b],
          runs: [run('running')],
          steps: [],
          waits: [],
        })
      )
    ).not.toContain('log.monotonic-order');
  });

  it('catches an out-of-order log', () => {
    const a = event({
      eventType: 'run_created',
      eventData: {
        deploymentId: 'd',
        workflowName: 'w',
        input: new Uint8Array(),
      },
    });
    const b = event({ eventType: 'run_started' });
    const violations = check({
      runId: RUN,
      // Appended in the wrong order relative to how `events.list` will sort
      // them: replay would see a different sequence than what happened.
      events: [b, a],
      runs: [run('running')],
      steps: [],
      waits: [],
    });
    expect(rules(violations)).toContain('log.monotonic-order');
    expect(rules(violations)).toContain('run.created-first');
  });

  it('catches a step restarted after it finished', () => {
    const events = [
      event({
        eventType: 'run_created',
        eventData: {
          deploymentId: 'd',
          workflowName: 'w',
          input: new Uint8Array(),
        },
      }),
      event({
        eventType: 'step_created',
        correlationId: 's1',
        eventData: { stepName: 'a', input: new Uint8Array() },
      }),
      event({ eventType: 'step_started', correlationId: 's1' }),
      event({
        eventType: 'step_completed',
        correlationId: 's1',
        eventData: { result: new Uint8Array() },
      }),
      event({ eventType: 'step_started', correlationId: 's1' }),
    ];
    expect(
      rules(
        check({
          runId: RUN,
          events,
          runs: [run('running')],
          steps: [],
          waits: [],
        })
      )
    ).toContain('step.no-restart-after-terminal');
  });

  it('catches an entity that disagrees with the log', () => {
    const events = [
      event({
        eventType: 'run_created',
        eventData: {
          deploymentId: 'd',
          workflowName: 'w',
          input: new Uint8Array(),
        },
      }),
      event({
        eventType: 'step_created',
        correlationId: 's1',
        eventData: { stepName: 'a', input: new Uint8Array() },
      }),
      event({ eventType: 'step_started', correlationId: 's1' }),
    ];
    const steps: Step[] = [
      {
        runId: RUN,
        stepId: 's1',
        stepName: 'a',
        status: 'completed',
        attempt: 4,
        createdAt: BASE,
        updatedAt: BASE,
      },
    ];
    const violations = rules(
      check({
        runId: RUN,
        events,
        runs: [run('running')],
        steps,
        waits: [],
      })
    );
    expect(violations).toContain('step.entity-matches-log');
    expect(violations).toContain('step.attempt-matches-log');
  });

  it('catches a run whose attributes disagree with its attr_set events', () => {
    const events = [
      event({
        eventType: 'run_created',
        eventData: {
          deploymentId: 'd',
          workflowName: 'w',
          input: new Uint8Array(),
        },
      }),
      event({
        eventType: 'attr_set',
        correlationId: 'a1',
        eventData: {
          changes: [{ key: 'approval', value: 'yes' }],
          writer: { type: 'workflow' },
        },
      }),
    ];
    const drifted = { ...run('running'), attributes: { approval: 'no' } };
    expect(
      rules(
        check({
          runId: RUN,
          events,
          runs: [drifted],
          steps: [],
          waits: [],
        })
      )
    ).toContain('run.attributes-match-log');

    const agreeing = { ...run('running'), attributes: { approval: 'yes' } };
    expect(
      rules(
        check({
          runId: RUN,
          events,
          runs: [agreeing],
          steps: [],
          waits: [],
        })
      )
    ).not.toContain('run.attributes-match-log');
  });

  it('honours a removal recorded as a null change', () => {
    const events = [
      event({
        eventType: 'run_created',
        eventData: {
          deploymentId: 'd',
          workflowName: 'w',
          input: new Uint8Array(),
          attributes: { seeded: 'v' },
        },
      }),
      event({
        eventType: 'attr_set',
        correlationId: 'a1',
        eventData: {
          changes: [{ key: 'seeded', value: null }],
          writer: { type: 'workflow' },
        },
      }),
    ];
    expect(
      rules(
        check({
          runId: RUN,
          events,
          runs: [{ ...run('running'), attributes: {} }],
          steps: [],
          waits: [],
        })
      )
    ).not.toContain('run.attributes-match-log');
  });

  it('catches two live hooks holding one token', () => {
    const events = [
      event({
        eventType: 'run_created',
        eventData: {
          deploymentId: 'd',
          workflowName: 'w',
          input: new Uint8Array(),
        },
      }),
      event({
        eventType: 'hook_created',
        correlationId: 'h1',
        eventData: { token: 't' },
      }),
      event({
        eventType: 'hook_created',
        correlationId: 'h2',
        eventData: { token: 't' },
      }),
    ];
    expect(
      rules(
        check({
          runId: RUN,
          events,
          runs: [run('running')],
          steps: [],
          waits: [],
        })
      )
    ).toContain('hook.token-unique');
  });

  it('allows a hook token to be reclaimed after disposal', () => {
    const events = [
      event({
        eventType: 'run_created',
        eventData: {
          deploymentId: 'd',
          workflowName: 'w',
          input: new Uint8Array(),
        },
      }),
      event({
        eventType: 'hook_created',
        correlationId: 'h1',
        eventData: { token: 't' },
      }),
      event({ eventType: 'hook_disposed', correlationId: 'h1' }),
      event({
        eventType: 'hook_created',
        correlationId: 'h2',
        eventData: { token: 't' },
      }),
    ];
    expect(
      rules(
        check({
          runId: RUN,
          events,
          runs: [run('running')],
          steps: [],
          waits: [],
        })
      )
    ).not.toContain('hook.token-unique');
  });

  it('catches a rewritten wait deadline', () => {
    const events = [
      event({
        eventType: 'run_created',
        eventData: {
          deploymentId: 'd',
          workflowName: 'w',
          input: new Uint8Array(),
        },
      }),
      event({
        eventType: 'wait_created',
        correlationId: 'w1',
        eventData: { resumeAt: new Date('2024-02-01T00:00:00Z') },
      }),
      event({
        eventType: 'wait_completed',
        correlationId: 'w1',
        eventData: { resumeAt: new Date('2024-03-01T00:00:00Z') },
      }),
    ];
    expect(
      rules(
        check({
          runId: RUN,
          events,
          runs: [run('running')],
          steps: [],
          waits: [],
        })
      )
    ).toContain('wait.resume-at-stable');
  });

  it('allows a running step to close out after the run ended, but nothing else', () => {
    const ok = [
      event({
        eventType: 'run_created',
        eventData: {
          deploymentId: 'd',
          workflowName: 'w',
          input: new Uint8Array(),
        },
      }),
      event({
        eventType: 'step_created',
        correlationId: 's1',
        eventData: { stepName: 'a', input: new Uint8Array() },
      }),
      event({ eventType: 'step_started', correlationId: 's1' }),
      event({ eventType: 'run_cancelled' }),
      event({
        eventType: 'step_completed',
        correlationId: 's1',
        eventData: { result: new Uint8Array() },
      }),
    ];
    expect(
      rules(
        check({
          runId: RUN,
          events: ok,
          runs: [run('cancelled')],
          steps: [],
          waits: [],
        })
      )
    ).not.toContain('run.terminal-is-last');

    const bad = [
      ...ok,
      event({
        eventType: 'hook_created',
        correlationId: 'h1',
        eventData: { token: 't' },
      }),
    ];
    expect(
      rules(
        check({
          runId: RUN,
          events: bad,
          runs: [run('cancelled')],
          steps: [],
          waits: [],
        })
      )
    ).toContain('run.terminal-is-last');
  });
});
