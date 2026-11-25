import type { CreateEventParams } from '@workflow/world';
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_REPORTED_DIVERGENCE_EVENT_IDS,
  ReplayRecoveryReporter,
  reportedDivergenceEventIds,
} from './replay-recovery-reporter.js';

describe('ReplayRecoveryReporter', () => {
  it('stays dormant until replay reaches a deterministic outcome', async () => {
    const create = vi.fn(async (_params: CreateEventParams) => 'created');
    const reporter = new ReplayRecoveryReporter(2);

    await reporter.withEventCreate({ requestId: 'req_1' }, create);

    expect(create).toHaveBeenCalledWith({ requestId: 'req_1' });
  });

  it('attaches telemetry to only the first successful natural write', async () => {
    const create = vi.fn(async (_params: CreateEventParams) => 'created');
    const reporter = new ReplayRecoveryReporter(2);
    reporter.activate();

    await reporter.withEventCreate({ requestId: 'req_1' }, create);
    await reporter.withEventCreate({ requestId: 'req_2' }, create);

    expect(create).toHaveBeenNthCalledWith(1, {
      requestId: 'req_1',
      replayDivergenceCount: 2,
    });
    expect(create).toHaveBeenNthCalledWith(2, { requestId: 'req_2' });
  });

  it('releases a failed write so the next natural write can report', async () => {
    const reporter = new ReplayRecoveryReporter(2);
    reporter.activate();

    await expect(
      reporter.withEventCreate({}, async () => {
        throw new Error('write failed');
      })
    ).rejects.toThrow('write failed');
    const create = vi.fn(async (_params: CreateEventParams) => 'created');
    await reporter.withEventCreate({}, create);

    expect(create).toHaveBeenCalledWith({ replayDivergenceCount: 2 });
  });

  it('reports the divergent event ids beside the count', async () => {
    const create = vi.fn(async (_params: CreateEventParams) => 'created');
    const reporter = new ReplayRecoveryReporter(2, ['evnt_a', 'evnt_b']);
    reporter.activate();

    await reporter.withEventCreate({ requestId: 'req_1' }, create);

    expect(create).toHaveBeenCalledWith({
      requestId: 'req_1',
      replayDivergenceCount: 2,
      replayDivergenceEventIds: ['evnt_a', 'evnt_b'],
    });
  });

  it('reports only the newest divergent event ids, and none when there are none', () => {
    const ids = Array.from(
      { length: MAX_REPORTED_DIVERGENCE_EVENT_IDS + 3 },
      (_, i) => `evnt_${i}`
    );

    expect(reportedDivergenceEventIds(ids)).toEqual({
      replayDivergenceEventIds: ids.slice(-MAX_REPORTED_DIVERGENCE_EVENT_IDS),
    });
    expect(reportedDivergenceEventIds([])).toEqual({});
    expect(reportedDivergenceEventIds(undefined)).toEqual({});
  });

  describe('inert()', () => {
    it('cannot be armed, so it never stamps a count', async () => {
      const create = vi.fn(async (_params: CreateEventParams) => 'created');
      const reporter = ReplayRecoveryReporter.inert();
      reporter.activate();

      await reporter.withEventCreate({ requestId: 'req_1' }, create);

      // A zero count would be rejected as out-of-range by the server, so the
      // inert reporter must not report at all rather than report zero.
      expect(create).toHaveBeenCalledWith({ requestId: 'req_1' });
    });

    it('passes undefined params straight through', async () => {
      const create = vi.fn(async (_params?: CreateEventParams) => 'created');
      const reporter = ReplayRecoveryReporter.inert();
      reporter.activate();

      await reporter.withEventCreate(undefined, create);

      expect(create).toHaveBeenCalledWith(undefined);
    });
  });
});
