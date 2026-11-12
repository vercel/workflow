import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SPEC_VERSION_CURRENT } from '@workflow/world';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { databaseFor } from '../db/index.js';
import { createStorage } from '../storage.js';
import { createRun } from '../test-helpers.js';

/**
 * Decoding a page of events is synchronous, so a page of large payloads ends
 * early (with `hasMore` and a cursor) instead of holding the thread while
 * it decodes a thousand of them.
 */

let dataDir: string;

beforeEach(() => {
  // Connections kept open: on Windows world-local's tests otherwise open one
  // per operation, which makes this many large writes too slow. The
  // connection is closed before the directory is removed.
  vi.stubEnv('WORKFLOW_LOCAL_SQLITE_KEEP_CONNECTIONS', '1');
  dataDir = mkdtempSync(path.join(tmpdir(), 'events-page-bytes-'));
});

afterEach(() => {
  databaseFor(dataDir).close();
  rmSync(dataDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

it('ends a page of large events early, and the cursor reaches every event', async () => {
  const storage = createStorage(dataDir);
  const run = await createRun(storage, {
    deploymentId: 'dep-1',
    workflowName: 'wf',
    input: new Uint8Array(),
  });
  const payload = new Uint8Array(64 * 1024).fill(1);
  for (let i = 0; i < 300; i++) {
    await storage.events.create(run.runId, {
      eventType: 'step_created',
      correlationId: `step_${i}`,
      specVersion: SPEC_VERSION_CURRENT,
      eventData: { stepName: 'add', input: payload },
    });
  }

  const pages: number[] = [];
  const seen: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await storage.events.list({
      runId: run.runId,
      pagination: { limit: 1_000, cursor },
    });
    pages.push(page.data.length);
    seen.push(...page.data.map((event) => event.eventId));
    cursor = page.hasMore ? (page.cursor ?? undefined) : undefined;
  } while (cursor);

  // run_created plus 300 steps, in order, none twice.
  expect(seen).toHaveLength(301);
  expect(new Set(seen).size).toBe(301);
  expect([...seen].sort()).toEqual(seen);
  // Several pages, none of them the whole log.
  expect(pages.length).toBeGreaterThan(2);
  expect(Math.max(...pages)).toBeLessThan(150);
});

it('returns small events in one page, as before', async () => {
  const storage = createStorage(dataDir);
  const run = await createRun(storage, {
    deploymentId: 'dep-1',
    workflowName: 'wf',
    input: new Uint8Array(),
  });
  for (let i = 0; i < 200; i++) {
    await storage.events.create(run.runId, {
      eventType: 'step_created',
      correlationId: `step_${i}`,
      specVersion: SPEC_VERSION_CURRENT,
      eventData: { stepName: 'add', input: new Uint8Array(8) },
    });
  }
  const page = await storage.events.list({
    runId: run.runId,
    pagination: { limit: 1_000 },
  });
  expect(page.data).toHaveLength(201);
  expect(page.hasMore).toBe(false);
});
