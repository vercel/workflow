import { describe, expect, it } from 'vitest';
import { runBounded, settleAllThrowFirst } from './settle-all.js';

const after = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('settleAllThrowFirst', () => {
  it('waits for every promise before it throws the first failure in list order', async () => {
    let lateSettled = false;
    const late = after(30).then(() => {
      lateSettled = true;
    });
    const second = after(5).then(() => {
      throw new Error('second');
    });
    const first = after(15).then(() => {
      throw new Error('first');
    });
    await expect(settleAllThrowFirst([first, second, late])).rejects.toThrow(
      'first'
    );
    expect(lateSettled).toBe(true);
  });

  it('resolves for no promises', async () => {
    await expect(settleAllThrowFirst([])).resolves.toBeUndefined();
  });
});

describe('runBounded', () => {
  it('keeps at most the limit in flight, and runs every task', async () => {
    let inFlight = 0;
    let most = 0;
    const ran: number[] = [];
    await runBounded(
      Array.from({ length: 10 }, (_, i) => async () => {
        inFlight++;
        most = Math.max(most, inFlight);
        await after(5);
        ran.push(i);
        inFlight--;
      }),
      3
    );
    expect(most).toBe(3);
    expect(ran.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('starts the first tasks before it returns', () => {
    const started: number[] = [];
    void runBounded(
      [0, 1, 2].map((i) => async () => {
        started.push(i);
        await after(1);
      }),
      2
    );
    expect(started).toEqual([0, 1]);
  });

  it('runs every task, then throws the first failure in list order', async () => {
    const ran: number[] = [];
    const task = (i: number, ms: number, fail: boolean) => async () => {
      await after(ms);
      ran.push(i);
      if (fail) throw new Error(`task ${i}`);
    };
    await expect(
      runBounded(
        [
          task(0, 20, false),
          task(1, 15, true),
          task(2, 1, true),
          task(3, 1, false),
        ],
        2
      )
    ).rejects.toThrow('task 1');
    expect(ran.sort()).toEqual([0, 1, 2, 3]);
  });

  it('resolves for no tasks', async () => {
    await expect(runBounded([], 4)).resolves.toBeUndefined();
  });
});
