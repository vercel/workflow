import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { slotToEventId } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Database, databaseFor } from '../db/index.js';
import { createStorage } from '../storage.js';
import { createRun } from '../test-helpers.js';
import { eventCursor, Store } from './store.js';

let dataDir: string;
let db: Database;
let store: Store;
let runId: string;

beforeEach(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'events-query-plan-'));
  const run = await createRun(createStorage(dataDir), {
    deploymentId: 'dep-1',
    workflowName: 'wf',
    input: new Uint8Array(),
  });
  runId = run.runId;
  db = databaseFor(dataDir);
  store = new Store(db, undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  databaseFor(dataDir).close();
  rmSync(dataDir, { recursive: true, force: true });
});

function plansOf(read: () => void): string[] {
  const get = vi.spyOn(db, 'get');
  const all = vi.spyOn(db, 'all');
  read();
  const calls = [...get.mock.calls, ...all.mock.calls];
  vi.restoreAllMocks();
  expect(calls.length).toBeGreaterThan(0);
  return calls.map(([sql, ...params]) =>
    db
      .all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...params)
      .map((row) => row.detail)
      .join(' | ')
  );
}

const cursor = eventCursor(slotToEventId(5));
const shapes = [
  { sortOrder: 'asc' as const },
  { sortOrder: 'desc' as const },
  { sortOrder: 'asc' as const, cursor },
  { sortOrder: 'desc' as const, cursor },
  { sortOrder: 'asc' as const, maxBytes: 1024 },
  { sortOrder: 'desc' as const, maxBytes: 1024 },
];

describe('event correlation lookups', () => {
  it('findEvent seeks events_by_correlation', () => {
    const [plan] = plansOf(() =>
      store.findEvent(runId, 'hook_1', 'hook_created')
    );
    expect(plan).toContain(
      'USING INDEX events_by_correlation (run_id=? AND correlation_id=?)'
    );
    expect(plan).not.toContain('TEMP B-TREE');
  });

  it.each(shapes)('listEvents by correlation seeks the index (%o)', (shape) => {
    for (const plan of plansOf(() =>
      store.listEvents(runId, { ...shape, correlationId: 'step_1' })
    )) {
      expect(plan).toContain(
        'USING INDEX events_by_correlation (run_id=? AND correlation_id=?'
      );
      expect(plan).not.toContain('TEMP B-TREE');
    }
  });

  it.each(
    shapes
  )('listEvents of a whole run keeps the primary key (%o)', (shape) => {
    for (const plan of plansOf(() => store.listEvents(runId, shape))) {
      expect(plan).toContain('USING PRIMARY KEY (run_id=?');
      expect(plan).not.toContain('TEMP B-TREE');
    }
  });
});
