import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { closeAllDatabases } from './db/index.js';
import { createStorage } from './storage.js';
import { createRun } from './test-helpers.js';

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'legacy-data-'));
});

afterEach(() => {
  closeAllDatabases();
  rmSync(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const newRun = (storage: ReturnType<typeof createStorage>) =>
  createRun(storage, {
    deploymentId: 'dep-1',
    workflowName: 'wf',
    input: new Uint8Array(),
  });

// Most apps never call world.start(), so the notice is tied to the first
// write after the upgrade, which creates world.db.
it('says once, when world.db is created next to the JSON data, that the earlier runs are no longer read', async () => {
  mkdirSync(path.join(dataDir, 'runs'));
  writeFileSync(path.join(dataDir, 'runs', 'wrun_A.json'), '{}');
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});

  await newRun(createStorage(dataDir));
  expect(info).toHaveBeenCalledTimes(1);
  expect(info.mock.calls[0][0]).toContain('no longer read');
  expect(info.mock.calls[0][0]).toContain(path.join(dataDir, 'runs'));

  // Reopening the database it created says nothing.
  closeAllDatabases();
  await newRun(createStorage(dataDir));
  expect(info).toHaveBeenCalledTimes(1);
});

it('says nothing in a data directory without JSON data', async () => {
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  await newRun(createStorage(dataDir));
  expect(info).not.toHaveBeenCalled();
});
