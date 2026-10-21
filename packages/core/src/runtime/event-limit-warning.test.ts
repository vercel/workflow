import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetEventLimitWarningsForTests,
  getEventLimitMilestone,
  maybeWarnApproachingEventLimit,
} from './event-limit-warning.js';

describe('getEventLimitMilestone', () => {
  it('returns undefined below the first milestone', () => {
    expect(getEventLimitMilestone(0, 25_000)).toBeUndefined();
    expect(getEventLimitMilestone(12_499, 25_000)).toBeUndefined();
  });

  it('returns the highest milestone reached', () => {
    expect(getEventLimitMilestone(12_500, 25_000)).toBe(0.5);
    expect(getEventLimitMilestone(20_000, 25_000)).toBe(0.8);
    expect(getEventLimitMilestone(23_750, 25_000)).toBe(0.95);
    expect(getEventLimitMilestone(24_999, 25_000)).toBe(0.95);
  });

  it('ignores missing, invalid, and exempt (MAX_SAFE_INTEGER) limits', () => {
    expect(getEventLimitMilestone(1_000_000, undefined)).toBeUndefined();
    expect(getEventLimitMilestone(1_000_000, 0)).toBeUndefined();
    expect(
      getEventLimitMilestone(1_000_000, Number.MAX_SAFE_INTEGER)
    ).toBeUndefined();
  });
});

describe('maybeWarnApproachingEventLimit', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetEventLimitWarningsForTests();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  const base = { runId: 'wrun_1', workflowName: 'wf', limit: 100 };

  it('does not warn below the first milestone', () => {
    maybeWarnApproachingEventLimit({
      ...base,
      eventCount: 49,
      isQuickJS: false,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns once per milestone per run, recommending QuickJS', () => {
    maybeWarnApproachingEventLimit({
      ...base,
      eventCount: 50,
      isQuickJS: false,
    });
    maybeWarnApproachingEventLimit({
      ...base,
      eventCount: 60,
      isQuickJS: false,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('WORKFLOW_VM=quickjs');
    expect(String(warn.mock.calls[0][0])).toContain('50 of 100 events');

    maybeWarnApproachingEventLimit({
      ...base,
      eventCount: 80,
      isQuickJS: false,
    });
    expect(warn).toHaveBeenCalledTimes(2);

    maybeWarnApproachingEventLimit({
      ...base,
      runId: 'wrun_2',
      eventCount: 50,
      isQuickJS: false,
    });
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it('uses a QuickJS-specific hint for QuickJS runs that still have a limit', () => {
    maybeWarnApproachingEventLimit({
      ...base,
      eventCount: 95,
      isQuickJS: true,
    });
    expect(String(warn.mock.calls[0][0])).toContain('snapshot threshold');
  });
});
