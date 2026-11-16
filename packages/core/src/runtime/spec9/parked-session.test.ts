import type { World } from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReplayPayloadCache } from '../../replay-payload-cache.js';
import type { WorkflowSession } from '../../workflow.js';
import {
  type ParkedSession,
  parkSession,
  takeParkedSession,
} from './parked-session.js';

const parked = (tailSlot: number): ParkedSession => ({
  session: {} as WorkflowSession,
  events: [],
  cursor: `cursor-${tailSlot}`,
  tailSlot,
  expectedSeqInBand: tailSlot,
  replayPayloadCache: {} as ReplayPayloadCache,
});

const newWorld = () => ({}) as World;
const MAX_AGE_MS = 10 * 60_000;

afterEach(() => {
  vi.useRealTimers();
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
