// @vitest-environment jsdom
import type { Event } from '@workflow/world';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type EventPayloadState,
  type LoadEventData,
  type UseEventPayloadOptions,
  useEventPayload,
} from './use-event-payload';

const stepCompleted = {
  eventId: 'evnt_step_completed',
  runId: 'wrun_1',
  eventType: 'step_completed',
  correlationId: 'step_1',
  createdAt: new Date(0),
  specVersion: 2,
  // List endpoints strip the ref fields, so this is incomplete.
  eventData: {},
} as unknown as Event;

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let latest: EventPayloadState;

function Probe(props: UseEventPayloadOptions) {
  latest = useEventPayload(props);
  return null;
}

const render = (props: UseEventPayloadOptions) =>
  act(async () => root.render(createElement(Probe, props)));

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
});

describe('useEventPayload', () => {
  it('keeps the decrypted payload when the sealed load settles after it', async () => {
    const sealed = deferred<unknown>();
    const decrypted = deferred<unknown>();
    const signals: AbortSignal[] = [];
    const load = vi.fn<LoadEventData>((_event, options) => {
      if (options?.signal) signals.push(options.signal);
      return signals.length === 1 ? sealed.promise : decrypted.promise;
    });

    await render({ event: stepCompleted, onLoadEventData: load });
    expect(latest.loading).toBe(true);

    // Decrypt is clicked while the first load is still in flight.
    const key = new Uint8Array([1]);
    await render({
      event: stepCompleted,
      onLoadEventData: load,
      encryptionKey: key,
    });
    expect(load).toHaveBeenCalledTimes(2);
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);

    await act(async () => decrypted.resolve({ result: 'decrypted' }));
    expect(latest).toEqual({
      data: { result: 'decrypted' },
      loading: false,
      error: null,
    });

    // The superseded load settles last and must not overwrite it.
    await act(async () => sealed.resolve({ result: 'sealed' }));
    expect(latest.data).toEqual({ result: 'decrypted' });
    expect(latest.loading).toBe(false);
  });

  it('drops the error of a superseded load', async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const load = vi
      .fn<LoadEventData>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    await render({ event: stepCompleted, onLoadEventData: load });
    await render({
      event: stepCompleted,
      onLoadEventData: load,
      encryptionKey: new Uint8Array([1]),
    });

    await act(async () => second.resolve({ result: 'decrypted' }));
    await act(async () => first.reject(new Error('stale failure')));

    expect(latest).toEqual({
      data: { result: 'decrypted' },
      loading: false,
      error: null,
    });
  });

  it('ignores a load that settles after unmount', async () => {
    const pending = deferred<unknown>();
    const onLoaded = vi.fn();
    const load = vi.fn<LoadEventData>(() => pending.promise);

    await render({ event: stepCompleted, onLoadEventData: load, onLoaded });
    await act(() => root.unmount());
    root = createRoot(container);

    await act(async () => pending.resolve({ result: 'late' }));
    expect(onLoaded).not.toHaveBeenCalled();
  });

  it('keeps the previous payload while a reload is in flight', async () => {
    const reload = deferred<unknown>();
    const onLoaded = vi.fn();
    const load = vi
      .fn<LoadEventData>()
      .mockResolvedValueOnce({ result: 'sealed' })
      .mockReturnValueOnce(reload.promise);

    await render({ event: stepCompleted, onLoadEventData: load, onLoaded });
    expect(latest.data).toEqual({ result: 'sealed' });
    expect(onLoaded).toHaveBeenCalledWith('evnt_step_completed', {
      result: 'sealed',
    });

    await render({
      event: stepCompleted,
      onLoadEventData: load,
      onLoaded,
      encryptionKey: new Uint8Array([1]),
    });
    expect(latest).toEqual({
      data: { result: 'sealed' },
      loading: true,
      error: null,
    });

    await act(async () => reload.reject(new Error('boom')));
    expect(latest).toEqual({
      data: { result: 'sealed' },
      loading: false,
      error: 'boom',
    });
  });

  it('waits until enabled, and skips the load when the payload is cached', async () => {
    const load = vi.fn<LoadEventData>().mockResolvedValue({ result: 1 });

    await render({
      event: stepCompleted,
      onLoadEventData: load,
      enabled: false,
    });
    expect(load).not.toHaveBeenCalled();
    expect(latest.loading).toBe(false);

    await render({
      event: stepCompleted,
      onLoadEventData: load,
      enabled: true,
    });
    expect(load).toHaveBeenCalledTimes(1);
    expect(latest.data).toEqual({ result: 1 });

    await act(() => root.unmount());
    root = createRoot(container);
    await render({
      event: stepCompleted,
      onLoadEventData: load,
      initialData: { result: 'cached' },
    });
    expect(load).toHaveBeenCalledTimes(1);
    expect(latest).toEqual({
      data: { result: 'cached' },
      loading: false,
      error: null,
    });
  });

  it('does not reload when the parent passes a new loader for the same event', async () => {
    const load = vi.fn<LoadEventData>().mockResolvedValue({ result: 1 });
    const key = new Uint8Array([1]);

    await render({
      event: stepCompleted,
      onLoadEventData: load,
      encryptionKey: key,
    });
    await render({
      event: { ...stepCompleted } as Event,
      onLoadEventData: (event, options) => load(event, options),
      encryptionKey: key,
    });

    expect(load).toHaveBeenCalledTimes(1);
  });
});
