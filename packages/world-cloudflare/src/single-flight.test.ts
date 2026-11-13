import { describe, expect, it } from 'vitest';
import { singleFlight } from './single-flight.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('singleFlight', () => {
  it('runs the work once for concurrent calls with the same key', async () => {
    const inflight = new Map<string, Promise<string>>();
    const gate = deferred<string>();
    let runs = 0;
    const work = () => {
      runs++;
      return gate.promise;
    };
    const first = singleFlight(inflight, 'k', work);
    const second = singleFlight(inflight, 'k', work);
    gate.resolve('outcome');
    expect(await first).toBe('outcome');
    expect(await second).toBe('outcome');
    expect(runs).toBe(1);
    expect(inflight.size).toBe(0);
  });

  it('runs different keys independently', async () => {
    const inflight = new Map<string, Promise<string>>();
    let runs = 0;
    const work = async () => `run ${++runs}`;
    const [a, b] = await Promise.all([
      singleFlight(inflight, 'a', work),
      singleFlight(inflight, 'b', work),
    ]);
    expect(new Set([a, b]).size).toBe(2);
    expect(runs).toBe(2);
  });

  it('shares a rejection, then lets a later call run again', async () => {
    const inflight = new Map<string, Promise<string>>();
    const gate = deferred<string>();
    let runs = 0;
    const failing = () => {
      runs++;
      return gate.promise;
    };
    const first = singleFlight(inflight, 'k', failing);
    const second = singleFlight(inflight, 'k', failing);
    gate.reject(new Error('boom'));
    await expect(first).rejects.toThrow('boom');
    await expect(second).rejects.toThrow('boom');
    expect(runs).toBe(1);
    expect(inflight.size).toBe(0);

    const retried = await singleFlight(inflight, 'k', async () => {
      runs++;
      return 'ok';
    });
    expect(retried).toBe('ok');
    expect(runs).toBe(2);
  });

  it('turns a synchronous throw into a rejection and clears the key', async () => {
    const inflight = new Map<string, Promise<string>>();
    await expect(
      singleFlight(inflight, 'k', () => {
        throw new Error('sync');
      })
    ).rejects.toThrow('sync');
    expect(inflight.size).toBe(0);
  });
});
