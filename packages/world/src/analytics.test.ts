import { describe, expect, it } from 'vitest';
import { AnalyticsRunSchema } from './analytics.js';

const base = {
  runId: 'wrun_01KX2M5N3RBNC12RYWYYH4WWQJ',
  status: 'completed',
  deploymentId: 'dpl_1',
  workflowName: 'workflow//./src/w//myWorkflow',
  updatedAt: '2026-07-13 17:09:11.593',
};

describe('analytics date coercion', () => {
  it('parses timezone-naive datetime strings as UTC regardless of process TZ', () => {
    // ClickHouse DateTime64 JSON shape: naive, UTC by convention.
    const run = AnalyticsRunSchema.parse({
      ...base,
      createdAt: '2026-07-13 17:09:11.593',
    });
    expect(run.createdAt.getTime()).toBe(Date.UTC(2026, 6, 13, 17, 9, 11, 593));
    expect(run.createdAt.toISOString()).toBe('2026-07-13T17:09:11.593Z');
  });

  it('accepts naive strings without fractional seconds', () => {
    const run = AnalyticsRunSchema.parse({
      ...base,
      createdAt: '2026-07-13 17:09:11',
    });
    expect(run.createdAt.toISOString()).toBe('2026-07-13T17:09:11.000Z');
  });

  it('leaves timezone-aware strings untouched', () => {
    const run = AnalyticsRunSchema.parse({
      ...base,
      createdAt: '2026-07-13T10:09:11.593-07:00',
    });
    expect(run.createdAt.toISOString()).toBe('2026-07-13T17:09:11.593Z');
    const zulu = AnalyticsRunSchema.parse({
      ...base,
      createdAt: '2026-07-13T17:09:11.593Z',
    });
    expect(zulu.createdAt.toISOString()).toBe('2026-07-13T17:09:11.593Z');
  });

  it('passes through Date objects and nullable fields', () => {
    const d = new Date('2026-07-13T17:09:11.593Z');
    const run = AnalyticsRunSchema.parse({
      ...base,
      createdAt: d,
      startedAt: '2026-07-13 17:09:12.000',
      completedAt: null,
    });
    expect(run.createdAt.getTime()).toBe(d.getTime());
    expect(run.startedAt?.toISOString()).toBe('2026-07-13T17:09:12.000Z');
    expect(run.completedAt).toBeNull();
  });
});
