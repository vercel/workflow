import type { Event, World } from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReplayPayloadCache } from '../../replay-payload-cache.js';
import type { WorkflowSession } from '../../workflow.js';
import {
  estimateParkedBytes,
  type ParkedSession,
  parkSession,
  takeParkedSession,
} from './parked-session.js';

const KIB = 1024;

/** A log whose serialized fields total `payloadBytes`. */
const logOf = (payloadBytes: number): Event[] =>
  payloadBytes === 0
    ? []
    : [
        {
          eventType: 'hook_received',
          eventData: { payload: new Uint8Array(payloadBytes) },
        } as unknown as Event,
      ];

const parked = (tailSlot: number, payloadBytes = 0): ParkedSession => ({
  session: {} as WorkflowSession,
  events: logOf(payloadBytes),
  cursor: `cursor-${tailSlot}`,
  tailSlot,
  expectedSeqInBand: tailSlot,
  replayPayloadCache: {} as ReplayPayloadCache,
});

const newWorld = () => ({}) as World;
const MAX_AGE_MS = 10 * 60_000;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('parked sessions', () => {
  it('keeps the entry further along when an older one is parked after it', () => {
    const world = newWorld();
    // A delivery that started later parked a newer VM while a no-op wake
    // still held the older one it took.
    parkSession(world, 'wrun_a', parked(12));
    parkSession(world, 'wrun_a', parked(10));
    expect(takeParkedSession(world, 'wrun_a')?.tailSlot).toBe(12);
  });

  it('replaces an entry with one at least as far along', () => {
    const world = newWorld();
    parkSession(world, 'wrun_a', parked(10));
    parkSession(world, 'wrun_a', parked(12));
    expect(takeParkedSession(world, 'wrun_a')?.tailSlot).toBe(12);
    expect(takeParkedSession(world, 'wrun_a')).toBeUndefined();
  });

  it('drops expired entries of other runs when the map is touched', () => {
    const world = newWorld();
    parkSession(world, 'wrun_old', parked(1), 0);
    parkSession(world, 'wrun_new', parked(1), MAX_AGE_MS);
    // Touching the map for another run drops the expired one.
    expect(takeParkedSession(world, 'wrun_new', MAX_AGE_MS + 1)).toBeDefined();
    parkSession(world, 'wrun_old', parked(0), MAX_AGE_MS + 1);
    // A park for the run after its entry expired is not refused by it.
    expect(takeParkedSession(world, 'wrun_old', MAX_AGE_MS + 1)?.tailSlot).toBe(
      0
    );
  });

  it('expires entries on a timer while nothing touches the map', () => {
    vi.useFakeTimers();
    const world = newWorld();
    parkSession(world, 'wrun_a', parked(1));
    vi.advanceTimersByTime(MAX_AGE_MS + 1);
    // Touching the map would expire it too, so look at it without the clock.
    expect(takeParkedSession(world, 'wrun_a', 0)).toBeUndefined();
  });
});

describe('the parked sessions byte budget', () => {
  // Each entry is estimated at 256 KiB plus three times its payload bytes.
  const entryBytes = (payloadBytes: number) =>
    estimateParkedBytes(logOf(payloadBytes));

  it('estimates an entry from its serialized fields', () => {
    expect(entryBytes(0)).toBe(256 * KIB);
    expect(entryBytes(100 * KIB)).toBe(556 * KIB);
  });

  it('does not park an entry over half the budget, and drops the older one', () => {
    vi.stubEnv('WORKFLOW_PARKED_VM_MAX_BYTES', String(2 * 1024 * KIB));
    const world = newWorld();
    parkSession(world, 'wrun_a', parked(1));
    expect(parkSession(world, 'wrun_a', parked(2, 300 * KIB))).toEqual({
      parked: false,
      bytes: entryBytes(300 * KIB),
      reason: 'too_large',
    });
    expect(takeParkedSession(world, 'wrun_a')).toBeUndefined();
  });

  it('evicts the oldest entries to keep the total within the budget', () => {
    vi.stubEnv('WORKFLOW_PARKED_VM_MAX_BYTES', String(2 * 1024 * KIB));
    const world = newWorld();
    // 556 KiB each: three fit in 2 MiB, a fourth evicts the oldest.
    for (const runId of ['wrun_a', 'wrun_b', 'wrun_c']) {
      expect(parkSession(world, runId, parked(1, 100 * KIB))).toMatchObject({
        parked: true,
        evicted: 0,
      });
    }
    expect(parkSession(world, 'wrun_d', parked(1, 100 * KIB))).toMatchObject({
      parked: true,
      evicted: 1,
    });
    expect(takeParkedSession(world, 'wrun_a')).toBeUndefined();
    // Taking an entry returns its bytes to the budget.
    expect(takeParkedSession(world, 'wrun_b')).toBeDefined();
    expect(parkSession(world, 'wrun_e', parked(1, 100 * KIB))).toMatchObject({
      parked: true,
      evicted: 0,
    });
    for (const runId of ['wrun_c', 'wrun_d', 'wrun_e']) {
      expect(takeParkedSession(world, runId)).toBeDefined();
    }
  });

  it('parks nothing with a budget of 0', () => {
    vi.stubEnv('WORKFLOW_PARKED_VM_MAX_BYTES', '0');
    const world = newWorld();
    expect(parkSession(world, 'wrun_a', parked(1))).toMatchObject({
      parked: false,
      reason: 'disabled',
    });
    expect(takeParkedSession(world, 'wrun_a')).toBeUndefined();
  });

  it('falls back to the default budget for an invalid value', () => {
    vi.stubEnv('WORKFLOW_PARKED_VM_MAX_BYTES', 'lots');
    const world = newWorld();
    expect(parkSession(world, 'wrun_a', parked(1, 100 * KIB))).toMatchObject({
      parked: true,
    });
  });
});
