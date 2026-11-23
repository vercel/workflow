import { describe, expect, it } from 'vitest';
import {
  createFlushableState,
  flushablePipe,
  pollWritableLock,
  trackFlushableWritable,
} from '../flushable-stream.js';
import { settleStepStreams } from './step-streams.js';

/** A server writable whose writes and close land when the test says so. */
function createSlowSink() {
  const landed: string[] = [];
  const pending: Array<() => void> = [];
  const hold = (label: string) =>
    new Promise<void>((resolve) => {
      pending.push(() => {
        landed.push(label);
        resolve();
      });
    });
  const sink = new WritableStream<string>({
    write: (chunk) => hold(`write:${chunk}`),
    close: () => hold('close'),
  });
  return {
    sink,
    landed,
    /** Lets every write or close currently in flight reach the server. */
    land: () => {
      for (const finish of pending.splice(0)) finish();
    },
    inFlight: () => pending.length,
  };
}

function createStepStream(sink: WritableStream<string>) {
  const { readable, writable } = new TransformStream<string, string>();
  const state = createFlushableState();
  flushablePipe(readable, sink, state).catch(() => {});
  const tracked = trackFlushableWritable(writable, state);
  pollWritableLock(tracked, state);
  return { state, writable: tracked };
}

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

/** Starts the wait a step makes before it completes and reports its outcome. */
function settle(...states: Parameters<typeof settleStepStreams>[0]) {
  const outcome = { settled: false };
  const settling = settleStepStreams(states).finally(() => {
    outcome.settled = true;
  });
  settling.catch(() => {});
  return { outcome, settling };
}

describe('settleStepStreams', () => {
  it('resolves at once when the step opened no streams', async () => {
    await expect(settleStepStreams([])).resolves.toBeUndefined();
  });

  it('resolves for a writable the step never wrote to', async () => {
    const server = createSlowSink();
    const { state } = createStepStream(server.sink);

    await settleStepStreams([state]);
    expect(server.landed).toEqual([]);
  });

  it('waits for writes queued by a released writer to reach the server', async () => {
    const server = createSlowSink();
    const { state, writable } = createStepStream(server.sink);

    const writer = writable.getWriter();
    // Not awaited: the step returns with the write still queued.
    void writer.write('a');
    writer.releaseLock();

    const { outcome, settling } = settle(state);
    await tick();
    expect(server.inFlight()).toBe(1);
    expect(outcome.settled).toBe(false);

    server.land();
    await settling;
    expect(server.landed).toEqual(['write:a']);
  });

  it('waits for the writes of a writer the step still holds', async () => {
    const server = createSlowSink();
    const { state, writable } = createStepStream(server.sink);

    // The transform accepts the chunk at once; the server has not.
    const writer = writable.getWriter();
    await writer.write('a');
    expect(writable.locked).toBe(true);

    const { outcome, settling } = settle(state);
    await tick();
    expect(outcome.settled).toBe(false);
    expect(server.landed).toEqual([]);

    server.land();
    await settling;
    expect(server.landed).toEqual(['write:a']);
    writer.releaseLock();
  });

  it('waits for every write queued behind one still in progress', async () => {
    const server = createSlowSink();
    const { state, writable } = createStepStream(server.sink);

    const writer = writable.getWriter();
    void writer.write('a');
    void writer.write('b');
    void writer.write('c');

    const { outcome, settling } = settle(state);
    for (const expected of [['write:a'], ['write:a', 'write:b']]) {
      await tick();
      server.land();
      await tick();
      expect(server.landed).toEqual(expected);
      expect(outcome.settled).toBe(false);
    }
    server.land();
    await settling;
    expect(server.landed).toEqual(['write:a', 'write:b', 'write:c']);
    writer.releaseLock();
  });

  it('does not wait for chunks written after the step ended', async () => {
    const server = createSlowSink();
    const { state, writable } = createStepStream(server.sink);

    const writer = writable.getWriter();
    void writer.write('a');
    const { settling } = settle(state);
    // A background writer carries on while the step completes.
    void writer.write('late');

    await tick();
    server.land();
    await settling;
    expect(server.landed).toEqual(['write:a']);

    await tick();
    server.land();
    writer.releaseLock();
  });

  it('waits for a closed writable to be flushed and closed, lock held or not', async () => {
    const server = createSlowSink();
    const { state, writable } = createStepStream(server.sink);

    // What `request.respondWith()` does: write, close, keep the writer.
    const writer = writable.getWriter();
    await writer.write('response');
    await writer.close();
    expect(writable.locked).toBe(true);

    const { outcome, settling } = settle(state);
    await tick();
    expect(outcome.settled).toBe(false);
    server.land(); // the write
    await tick();
    expect(outcome.settled).toBe(false);
    server.land(); // the close
    await settling;
    expect(server.landed).toEqual(['write:response', 'close']);
  });

  it('waits for a write and a close the step did not await', async () => {
    const server = createSlowSink();
    const { state, writable } = createStepStream(server.sink);

    const writer = writable.getWriter();
    void writer.write('a');
    void writer.close();

    const { outcome, settling } = settle(state);
    await tick();
    expect(outcome.settled).toBe(false);
    server.land(); // the write
    await tick();
    expect(outcome.settled).toBe(false);
    expect(server.inFlight()).toBe(1);
    server.land(); // the close
    await settling;
    expect(server.landed).toEqual(['write:a', 'close']);
  });

  it('waits for a close queued behind a write whose serialization outlasts the server write', async () => {
    const landed: string[] = [];
    // The frame is on the server before the serializer's `transform()` has
    // returned, so the write is confirmed before the queued close has reached
    // the pipe.
    const serialize = new TransformStream<string, string>({
      async transform(chunk, controller) {
        controller.enqueue(chunk);
        await tick();
      },
    });
    const state = createFlushableState();
    flushablePipe(
      serialize.readable,
      new WritableStream<string>({
        write(chunk) {
          landed.push(`write:${chunk}`);
        },
        close() {
          landed.push('close');
        },
      }),
      state
    ).catch(() => {});
    const writable = trackFlushableWritable(serialize.writable, state);

    const writer = writable.getWriter();
    void writer.write('a');
    void writer.close();

    await settleStepStreams([state]);
    expect(landed).toEqual(['write:a', 'close']);
  });

  it('keeps waiting for the other streams when one fails', async () => {
    const server = createSlowSink();
    const healthy = createStepStream(server.sink);
    const refused = createStepStream(
      new WritableStream<string>({
        write: () =>
          Promise.reject(new Error('Run "wrun_1" is already completed')),
      })
    );

    for (const { writable } of [refused, healthy]) {
      const writer = writable.getWriter();
      void writer.write('a').catch(() => {});
      writer.releaseLock();
    }

    const { outcome, settling } = settle(refused.state, healthy.state);
    await tick(30);
    expect(outcome.settled).toBe(false);
    expect(server.landed).toEqual([]);

    server.land();
    await expect(settling).rejects.toThrow('Run "wrun_1" is already completed');
    expect(server.landed).toEqual(['write:a']);
  });

  it('rejects with the error of a write the server refused', async () => {
    const { state, writable } = createStepStream(
      new WritableStream<string>({
        write: () =>
          Promise.reject(new Error('Run "wrun_1" is already completed')),
      })
    );

    const writer = writable.getWriter();
    void writer.write('a').catch(() => {});
    writer.releaseLock();

    await expect(settleStepStreams([state])).rejects.toThrow(
      'Run "wrun_1" is already completed'
    );
  });

  it('rejects when the writes do not reach the server in time', async () => {
    const server = createSlowSink();
    const { state, writable } = createStepStream(server.sink);

    const writer = writable.getWriter();
    void writer.write('a');
    writer.releaseLock();

    await expect(settleStepStreams([state], 20)).rejects.toThrow(
      'Timed out draining step stream writes after 20ms'
    );
    server.land();
  });

  it('leaves no lock polling behind for a writable the step never settled', async () => {
    // A step that fails before its body runs never asks for a settle.
    const { state } = createStepStream(new WritableStream());

    await state.promise;
    await tick(150);
    expect(state.writablePollingInterval).toBeUndefined();
  });
});
