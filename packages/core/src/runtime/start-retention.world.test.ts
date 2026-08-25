import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorld } from '@workflow/world-local';
import { afterEach, describe, expect, it } from 'vitest';
import { start } from './start.js';

/**
 * `start({ retention })` against a real World, rather than the mocks in
 * `start.test.ts`. Those pin what the SDK sends; this pins what a World
 * actually ends up storing — that the reserved key survives validation on the
 * way in, and that `'default'` really is indistinguishable from omission on
 * the created run.
 */
describe('start({ retention }) against world-local', () => {
  const workflow = Object.assign(() => Promise.resolve('ok'), {
    workflowId: 'retention-workflow',
  });
  const worlds: Array<ReturnType<typeof createWorld>> = [];

  function makeWorld() {
    const world = createWorld({
      directory: mkdtempSync(join(tmpdir(), 'wf-retention-')),
    });
    worlds.push(world);
    return world;
  }

  afterEach(async () => {
    await Promise.all(worlds.splice(0).map((world) => world.close?.()));
  });

  async function startWith(retention?: string) {
    const world = makeWorld();
    const run = await start(workflow as never, [], {
      world,
      ...(retention === undefined ? {} : { retention }),
    });
    return world.runs.get(run.runId, { remoteRefBehavior: 'lazy' });
  }

  it("stores $retention: 'none' on the created run", async () => {
    await expect(startWith('none')).resolves.toMatchObject({
      attributes: { $retention: 'none' },
    });
  });

  it('stores a World-specific value verbatim', async () => {
    await expect(startWith('7d')).resolves.toMatchObject({
      attributes: { $retention: '7d' },
    });
  });

  it("stores nothing for 'default' or omission", async () => {
    const [explicit, omitted] = await Promise.all([
      startWith('default'),
      startWith(),
    ]);
    expect(explicit.attributes).toEqual({});
    expect(omitted.attributes).toEqual(explicit.attributes);
  });
});
