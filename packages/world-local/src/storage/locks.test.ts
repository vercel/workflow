/**
 * Native concurrency locks on the Local World: the shared conformance suite
 * (each test on a fresh data directory, with a second storage instance on
 * the same directory standing in for a second process), plus the
 * world-local-specific crash repair.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Storage } from '@workflow/world';
import { afterAll } from 'vitest';
import { lockConformance } from '../../../world/src/test-support/lock-conformance.js';
import { createWorld } from '../index.js';
import { createStorage } from '../storage.js';

const dirs: string[] = [];
const dirOf = new WeakMap<object, string>();
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function freshDir(prefix: string) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function storageFor(events: Storage['events']) {
  const dir = dirOf.get(events);
  if (!dir) throw new Error('unknown events storage');
  return createStorage(dir);
}

lockConformance({
  name: 'world-local',
  events: () => {
    const dir = freshDir('wl-locks-');
    const { events } = createStorage(dir);
    dirOf.set(events, dir);
    return events;
  },
  secondEvents: (first) => storageFor(first).events,
  locks: (events) => storageFor(events).locks,
  capabilities: () =>
    createWorld({ dataDir: freshDir('wl-locks-caps-') }).capabilities,
  newRunId: () => null,
});
