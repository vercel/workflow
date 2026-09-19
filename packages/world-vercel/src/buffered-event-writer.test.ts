import type {
  CreateEventParams,
  CreateEventRequest,
  EventResult,
} from '@workflow/world';
import { expect, it, vi } from 'vitest';
import { BufferedEventWriter } from './buffered-event-writer.js';

const hook: CreateEventRequest = {
  eventType: 'hook_received',
  specVersion: 6,
  correlationId: 'hook_test',
  eventData: { token: 'private-token', payload: Uint8Array.of(1) },
};
const createStep: CreateEventRequest = {
  eventType: 'step_created',
  specVersion: 6,
  correlationId: 'step_test',
  eventData: { stepName: 'step', input: Uint8Array.of(2) },
};
const startStep: CreateEventRequest = {
  eventType: 'step_started',
  specVersion: 6,
  correlationId: 'step_test',
  eventData: { stepName: 'step' },
};

function fixture() {
  const calls: {
    event: CreateEventRequest;
    params: CreateEventParams;
    resolve(result: EventResult): void;
    reject(error: Error): void;
  }[] = [];
  const release = vi.fn(async () => {});
  const writer = new BufferedEventWriter(
    'wrun_test',
    (event, params, sent) => {
      sent?.();
      return new Promise<EventResult>((resolve, reject) =>
        calls.push({ event, params, resolve, reject })
      );
    },
    release
  );
  return { writer, calls, release };
}

it('sends the whole input/create/start prefix before any durable response, then waits at one barrier', async () => {
  const { writer, calls } = fixture();
  const expected: EventResult[] = [];
  for (const [i, event] of [hook, createStep, startStep].entries())
    expected.push(await writer.stage(event, { eventCount: 3 + i }));
  expect(calls.map((call) => call.event.eventType)).toEqual([
    'hook_received',
    'step_created',
    'step_started',
  ]);
  expect(writer.heads).toEqual({ queued: 6, committed: 3 });
  for (const [i, call] of calls.entries())
    expect(call.params.occurredAt).toEqual(expected[i].event!.createdAt);
  let finished = false;
  const barrier = writer.flush().then((results) => {
    finished = true;
    return results;
  });
  calls[0].resolve(expected[0]);
  calls[1].resolve(expected[1]);
  await Promise.resolve();
  expect(finished).toBe(false);
  calls[2].resolve(expected[2]);
  expect(await barrier).toEqual(expected);
  expect(writer.heads).toEqual({ queued: 6, committed: 6 });
  expect(await writer.flush()).toEqual([]);
});

it('preserves native hook registration instead of inventing its materialization or conflict outcome', async () => {
  const { writer, calls } = fixture();
  const request = {
    eventType: 'hook_created',
    specVersion: 4,
    correlationId: 'hook_new',
    eventData: { token: 'new-token' },
  } as CreateEventRequest;
  let finished = false;
  const result = writer.stage(request, { eventCount: 3 }).then((value) => {
    finished = true;
    return value;
  });
  await vi.waitFor(() => expect(calls).toHaveLength(1));
  expect(finished).toBe(false);
  const canonical = {
    event: { eventId: 'evnt_00000000000000000000000004' },
    hook: {
      resumeContext: { deploymentId: 'deployment', workflowName: 'workflow' },
    },
  } as unknown as EventResult;
  calls[0].resolve(canonical);
  expect(await result).toBe(canonical);
});

it('fails the barrier and future staging when any member fails', async () => {
  const { writer, calls, release } = fixture();
  const first = await writer.stage(hook, { eventCount: 3 });
  await writer.stage(createStep, { eventCount: 4 });
  calls[0].resolve(first);
  calls[1].reject(new Error('canonical persistence failed'));
  await expect(writer.flush()).rejects.toThrow('canonical persistence failed');
  await expect(writer.stage(startStep, { eventCount: 5 })).rejects.toThrow(
    'canonical persistence failed'
  );
  expect(release).toHaveBeenCalled();
});

it.each([
  'eventId',
  'createdAt',
] as const)('rejects canonical %s disagreement rather than executing against a different history', async (field) => {
  const { writer, calls } = fixture();
  const staged = await writer.stage(hook, { eventCount: 3 });
  calls[0].resolve({
    ...staged,
    event: {
      ...staged.event!,
      [field]:
        field === 'eventId'
          ? 'evnt_00000000000000000000000005'
          : new Date(+staged.event!.createdAt + 1),
    },
  });
  await expect(writer.flush()).rejects.toThrow('acknowledgement mismatch');
});

it('copies submitted bytes before the caller can mutate them', async () => {
  const { writer, calls } = fixture();
  const payload = Uint8Array.of(7);
  const staged = await writer.stage(
    { ...hook, eventData: { token: 'token', payload } },
    { eventCount: 3 }
  );
  payload[0] = 99;
  expect((calls[0].event.eventData as { payload: Uint8Array }).payload).toEqual(
    Uint8Array.of(7)
  );
  calls[0].resolve(staged);
  await writer.flush();
});

it('buffers a completion using the acknowledged step state and sends flush-through before awaiting replies', async () => {
  const calls: {
    event: CreateEventRequest;
    resolve(value: EventResult): void;
  }[] = [];
  const flush = vi.fn(async () => {});
  const writer = new BufferedEventWriter(
    'wrun_test',
    (event, _params, sent) => {
      sent?.();
      return new Promise((resolve) => calls.push({ event, resolve }));
    },
    async () => {},
    flush
  );
  const created = await writer.stage(createStep, { eventCount: 1 });
  const started = await writer.stage(startStep, { eventCount: 2 });
  calls[0].resolve(created);
  calls[1].resolve(started);
  await writer.flush();
  const completed = await writer.stage(
    {
      eventType: 'step_completed',
      specVersion: 6,
      correlationId: 'step_test',
      eventData: { result: Uint8Array.of(8) },
    },
    { eventCount: 3 }
  );
  expect(completed.step?.status).toBe('completed');
  const barrier = writer.flush();
  expect(flush).toHaveBeenLastCalledWith(4);
  calls[2].resolve(completed);
  await barrier;
});
