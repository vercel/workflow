import { describe, expect, it } from 'vitest';
import {
  type AlarmInput,
  type AlarmSignal,
  computeAlarmTarget,
} from './alarm.js';

const NOW = 1_000_000;

function signal(overrides: Partial<AlarmSignal> = {}): AlarmSignal {
  return {
    kind: 'flow',
    runAt: NOW,
    parked: false,
    inflight: false,
    pinned: false,
    ...overrides,
  };
}

function input(overrides: Partial<AlarmInput> = {}): AlarmInput {
  return {
    now: NOW,
    signals: [],
    waitDeadlines: [],
    flowBusy: false,
    stepSlotsFull: false,
    inflightCount: 0,
    backstopMs: 10_000,
    pinnedRecheckMs: 3_600_000,
    ...overrides,
  };
}

describe('computeAlarmTarget', () => {
  it('arms nothing when nothing is stored', () => {
    expect(computeAlarmTarget(input())).toBeNull();
  });

  it('arms at the earliest due signal or wait deadline', () => {
    expect(
      computeAlarmTarget(
        input({
          signals: [
            signal({ runAt: NOW + 5000 }),
            signal({ runAt: NOW + 2000 }),
          ],
          waitDeadlines: [NOW + 3000],
        })
      )
    ).toBe(NOW + 2000);
    expect(
      computeAlarmTarget(
        input({
          signals: [signal({ runAt: NOW + 5000 })],
          waitDeadlines: [NOW + 1000],
        })
      )
    ).toBe(NOW + 1000);
  });

  it('ignores parked and in-flight signals', () => {
    expect(
      computeAlarmTarget(
        input({
          signals: [signal({ parked: true }), signal({ inflight: true })],
        })
      )
    ).toBeNull();
  });

  it('re-checks pinned signals occasionally rather than at their runAt', () => {
    expect(
      computeAlarmTarget(input({ signals: [signal({ pinned: true })] }))
    ).toBe(NOW + 3_600_000);
  });

  // A due signal that cannot start would otherwise arm the alarm in the past,
  // and the alarm would fire again at once for as long as the blocking
  // delivery runs.
  it('does not re-arm immediately for a due flow signal behind a running flow delivery', () => {
    const target = computeAlarmTarget(
      input({
        signals: [
          signal({ kind: 'flow', inflight: true }),
          signal({ kind: 'flow', runAt: NOW - 50 }),
        ],
        flowBusy: true,
        inflightCount: 1,
      })
    );
    expect(target).toBe(NOW + 10_000);
  });

  it('does not re-arm immediately for a due step signal when every step slot is taken', () => {
    const target = computeAlarmTarget(
      input({
        signals: [signal({ kind: 'step', runAt: NOW - 50 })],
        stepSlotsFull: true,
        inflightCount: 6,
      })
    );
    expect(target).toBe(NOW + 10_000);
  });

  it('still arms for a due signal of the kind that has capacity', () => {
    const target = computeAlarmTarget(
      input({
        signals: [signal({ kind: 'step', runAt: NOW - 50 })],
        flowBusy: true,
        inflightCount: 1,
      })
    );
    expect(target).toBe(NOW - 50);
  });

  it('arms at a blocked signal that is not yet due', () => {
    const target = computeAlarmTarget(
      input({
        signals: [signal({ kind: 'flow', runAt: NOW + 2000 })],
        flowBusy: true,
        inflightCount: 1,
      })
    );
    expect(target).toBe(NOW + 2000);
  });
});
