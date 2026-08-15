import type { World } from '@workflow/world';
import { ulid } from 'ulid';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyWaitWedgeObservation,
  decodeWaitIdRunEpochMs,
  getWaitWedgeFailAfterSeconds,
  isWaitCreatedRowReadable,
  WAIT_WEDGE_FAIL_AFTER_SECONDS,
  waitWedgeErrorMessage,
} from './wait-wedge.js';

const resumeAtMs = Date.parse('2026-05-19T12:00:05.000Z');

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('classifyWaitWedgeObservation', () => {
  it('is silent before resumeAt', () => {
    expect(
      classifyWaitWedgeObservation({ resumeAtMs, nowMs: resumeAtMs - 1 })
    ).toBe('silent');
  });

  it('warns from resumeAt up to the threshold', () => {
    expect(
      classifyWaitWedgeObservation({ resumeAtMs, nowMs: resumeAtMs })
    ).toBe('warn');
    expect(
      classifyWaitWedgeObservation({
        resumeAtMs,
        nowMs: resumeAtMs + WAIT_WEDGE_FAIL_AFTER_SECONDS * 1000,
      })
    ).toBe('warn');
  });

  it('fails past the threshold', () => {
    expect(
      classifyWaitWedgeObservation({
        resumeAtMs,
        nowMs: resumeAtMs + WAIT_WEDGE_FAIL_AFTER_SECONDS * 1000 + 1,
      })
    ).toBe('fail');
  });

  it('honors the WORKFLOW_WAIT_WEDGE_FAIL_AFTER_SECONDS override', () => {
    vi.stubEnv('WORKFLOW_WAIT_WEDGE_FAIL_AFTER_SECONDS', '10');
    expect(getWaitWedgeFailAfterSeconds()).toBe(10);
    expect(
      classifyWaitWedgeObservation({
        resumeAtMs,
        nowMs: resumeAtMs + 11_000,
      })
    ).toBe('fail');
    expect(
      classifyWaitWedgeObservation({
        resumeAtMs,
        nowMs: resumeAtMs + 9_000,
      })
    ).toBe('warn');
  });

  it('falls back to the default on an invalid override', () => {
    vi.stubEnv('WORKFLOW_WAIT_WEDGE_FAIL_AFTER_SECONDS', 'soon');
    expect(getWaitWedgeFailAfterSeconds()).toBe(WAIT_WEDGE_FAIL_AFTER_SECONDS);
  });
});

describe('waitWedgeErrorMessage', () => {
  it('names the wait, the run, and how long past resumeAt the wedge is', () => {
    const message = waitWedgeErrorMessage({
      runId: 'wrun_test',
      correlationId: 'wait_abc',
      resumeAtMs,
      nowMs: resumeAtMs + 700_000,
    });
    expect(message).toContain('wait_abc');
    expect(message).toContain('wrun_test');
    expect(message).toContain('wait_completed');
    expect(message).toContain("700s after the wait's resumeAt");
  });
});

describe('decodeWaitIdRunEpochMs', () => {
  it('decodes the ULID timestamp (the run epoch) from a wait correlation id', () => {
    const atMs = Date.parse('2026-05-19T12:00:00.000Z');
    expect(decodeWaitIdRunEpochMs(`wait_${ulid(atMs)}`)).toBe(atMs);
  });

  it('returns undefined for non-wait ids and malformed ULIDs', () => {
    expect(decodeWaitIdRunEpochMs('step_01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(
      undefined
    );
    expect(decodeWaitIdRunEpochMs('wait_not-a-ulid')).toBe(undefined);
  });
});

describe('isWaitCreatedRowReadable', () => {
  const listWorld = (
    pages: Array<{ data: unknown[]; hasMore: boolean; cursor: string | null }>
  ) => {
    let call = 0;
    return {
      events: {
        list: vi.fn(async () => pages[Math.min(call++, pages.length - 1)]),
      },
    } as unknown as World;
  };

  it('finds the row across pages', async () => {
    const world = listWorld([
      { data: [], hasMore: true, cursor: 'c1' },
      {
        data: [{ eventType: 'wait_created', correlationId: 'wait_x' }],
        hasMore: false,
        cursor: null,
      },
    ]);
    await expect(
      isWaitCreatedRowReadable(world, 'wrun_test', 'wait_x')
    ).resolves.toBe(true);
  });

  it('reports the row unreadable when the full log lacks it', async () => {
    const world = listWorld([
      {
        data: [{ eventType: 'wait_created', correlationId: 'wait_other' }],
        hasMore: false,
        cursor: null,
      },
    ]);
    await expect(
      isWaitCreatedRowReadable(world, 'wrun_test', 'wait_x')
    ).resolves.toBe(false);
  });

  it('fails open on read errors', async () => {
    const world = {
      events: { list: vi.fn().mockRejectedValue(new Error('boom')) },
    } as unknown as World;
    await expect(
      isWaitCreatedRowReadable(world, 'wrun_test', 'wait_x')
    ).resolves.toBe(true);
  });
});
