import { describe, expect, test } from 'vitest';
import { parkedRun } from '../src/queue-auth.mjs';

type Event = { eventId: string; eventType: string; correlationId?: string };

/**
 * A fetcher whose run log is scripted: each `getEvents` call returns the next
 * entry of `polls` (the last one repeats), so a test fixes exactly what
 * `parkedRun` sees on every poll.
 */
function scripted(polls: string[][]) {
  let calls = 0;
  const seen: Event[][] = [];
  const toEvents = (types: string[]): Event[] =>
    types.map((entry, i) => {
      const [eventType, correlationId] = entry.split(':');
      return { eventId: `evnt_${i}`, eventType, correlationId };
    });
  const fetcher = {
    invoke: async () => ({ runId: 'wrun_test' }),
    getRun: async () => ({ status: 'running', workflowName: 'w' }) as never,
    getEvents: async () => {
      const events = toEvents(polls[Math.min(calls, polls.length - 1)]);
      calls++;
      seen.push(events);
      return events as never;
    },
  };
  return { fetcher, seen };
}

const parked = ['run_created', 'run_started', 'hook_created'];

describe('parkedRun', { timeout: 30_000 }, () => {
  // The Windows spec 9 failure: the run's first step was still running, so
  // the log stayed the same for longer than a poll interval, and its
  // `step_completed` landed after the run was taken to be parked.
  test('waits out a step that is quiet but still running', async () => {
    const running = [...parked, 'step_started:step_1'];
    const done = [...running, 'step_completed:step_1'];
    const { fetcher, seen } = scripted([
      parked,
      running,
      running,
      running,
      running,
      done,
    ]);

    await parkedRun(fetcher as never);

    // Parked only once the step had ended.
    expect(seen.at(-1)?.map((e) => e.eventType)).toContain('step_completed');
  });

  test.each([
    [
      'spec 8 (step_created, then step_started)',
      ['step_created:s', 'step_started:s'],
    ],
    ['spec 9 inline (step_started only)', ['step_started:s']],
  ])('settles a %s step once it completes', async (_name, start) => {
    const done = [...parked, ...start, 'step_completed:s'];
    const { fetcher, seen } = scripted([parked, done]);

    await parkedRun(fetcher as never);

    expect(seen.at(-1)?.map((e) => e.eventType)).toEqual(
      done.map((entry) => entry.split(':')[0])
    );
  });

  test('treats a failed step as ended', async () => {
    const done = [...parked, 'step_started:s', 'step_failed:s'];
    const { fetcher } = scripted([parked, done]);

    await expect(parkedRun(fetcher as never)).resolves.toMatchObject({
      runId: 'wrun_test',
    });
  });
});
