import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createRun } from '../test-helpers.js';
import { createStorage } from './index.js';

// world-sqlite: filesystem claim-adoption publication gates have no transactional equivalent.
it('publishes unrelated hook creations once each', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hook-publication-'));
  try {
    const storage = createStorage(dir);
    const run = await createRun(storage, {
      deploymentId: 'dpl_test',
      workflowName: 'test',
      input: new Uint8Array(),
    });
    await Promise.all(
      ['first', 'other'].map((id) =>
        createStorage(dir).events.create(run.runId, {
          eventType: 'hook_created',
          correlationId: 'hook_' + id,
          eventData: { token: 'token_' + id },
        })
      )
    );
    const { data } = await storage.events.list({ runId: run.runId });
    expect(
      data
        .filter((e) => e.eventType === 'hook_created')
        .map((e) => e.correlationId)
    ).toEqual(['hook_first', 'hook_other']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
