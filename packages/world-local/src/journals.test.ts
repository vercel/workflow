import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EntityConflictError } from '@workflow/errors';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorld } from './index.js';
import { createJournals } from './journals.js';

describe('world-local journals', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-journals-'));
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('creates, reads, and updates opaque state', async () => {
    const journals = createJournals(testDir);

    expect(await journals.get('session:123')).toBeNull();

    const created = await journals.commit(
      'session:123',
      new Uint8Array([0, 1, 255]),
      { expectedRevision: null, idempotencyKey: 'create' }
    );
    expect(created).toEqual({
      journalId: 'session:123',
      revision: '1',
      state: new Uint8Array([0, 1, 255]),
    });
    expect(await journals.get('session:123')).toEqual(created);

    const updated = await journals.commit('session:123', new Uint8Array([2]), {
      expectedRevision: created.revision,
      idempotencyKey: 'update',
    });
    expect(updated.revision).toBe('2');
    expect(await journals.get('session:123')).toEqual(updated);
  });

  it('returns the original commit when an idempotent retry follows later writes', async () => {
    const journals = createJournals(testDir);
    const created = await journals.commit('session:123', new Uint8Array([1]), {
      expectedRevision: null,
      idempotencyKey: 'create',
    });
    await journals.commit('session:123', new Uint8Array([2]), {
      expectedRevision: created.revision,
      idempotencyKey: 'update',
    });

    await expect(
      journals.commit('session:123', new Uint8Array([1]), {
        expectedRevision: null,
        idempotencyKey: 'create',
      })
    ).resolves.toEqual(created);
  });

  it('rejects stale revisions and conflicting idempotency-key reuse', async () => {
    const journals = createJournals(testDir);
    await journals.commit('session:123', new Uint8Array([1]), {
      expectedRevision: null,
      idempotencyKey: 'create',
    });

    await expect(
      journals.commit('session:123', new Uint8Array([2]), {
        expectedRevision: null,
        idempotencyKey: 'second-create',
      })
    ).rejects.toBeInstanceOf(EntityConflictError);
    await expect(
      journals.commit('session:123', new Uint8Array([2]), {
        expectedRevision: null,
        idempotencyKey: 'create',
      })
    ).rejects.toBeInstanceOf(EntityConflictError);
    expect((await journals.get('session:123'))?.revision).toBe('1');
  });

  it('allows one winner when independent instances commit the same revision', async () => {
    const first = createJournals(testDir);
    const second = createJournals(testDir);
    const created = await first.commit('session:123', new Uint8Array([1]), {
      expectedRevision: null,
      idempotencyKey: 'create',
    });

    const results = await Promise.allSettled([
      first.commit('session:123', new Uint8Array([2]), {
        expectedRevision: created.revision,
        idempotencyKey: 'writer-1',
      }),
      second.commit('session:123', new Uint8Array([3]), {
        expectedRevision: created.revision,
        idempotencyKey: 'writer-2',
      }),
    ]);

    expect(
      results.filter((result) => result.status === 'fulfilled')
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({ reason: { name: 'EntityConflictError' } });
    expect((await first.get('session:123'))?.revision).toBe('2');
  });

  it('converges concurrent retries of the same logical commit', async () => {
    const first = createJournals(testDir);
    const second = createJournals(testDir);

    const [left, right] = await Promise.all([
      first.commit('session:123', new Uint8Array([1]), {
        expectedRevision: null,
        idempotencyKey: 'create',
      }),
      second.commit('session:123', new Uint8Array([1]), {
        expectedRevision: null,
        idempotencyKey: 'create',
      }),
    ]);

    expect(left).toEqual(right);
    expect(left.revision).toBe('1');
  });

  it('persists across World instances and isolates tagged journals', async () => {
    const first = createWorld({
      dataDir: testDir,
      recoverActiveRuns: false,
      tag: 'first',
    });
    const second = createWorld({
      dataDir: testDir,
      recoverActiveRuns: false,
      tag: 'second',
    });
    const firstState = await first.journals.commit(
      'session:123',
      new Uint8Array([1]),
      { expectedRevision: null, idempotencyKey: 'create-first' }
    );
    const secondState = await second.journals.commit(
      'session:123',
      new Uint8Array([2]),
      { expectedRevision: null, idempotencyKey: 'create-second' }
    );

    expect((await first.journals.get('session:123'))?.state).toEqual(
      firstState.state
    );
    expect((await second.journals.get('session:123'))?.state).toEqual(
      secondState.state
    );

    await first.clear();
    expect(await first.journals.get('session:123')).toBeNull();
    expect(await second.journals.get('session:123')).toEqual(secondState);

    const reopened = createWorld({
      dataDir: testDir,
      recoverActiveRuns: false,
      tag: 'second',
    });
    expect(await reopened.journals.get('session:123')).toEqual(secondState);
    await Promise.all([first.close?.(), second.close?.(), reopened.close?.()]);
  });

  it.each([
    { name: 'tagged', tag: 'clear-race' },
    { name: 'untagged', tag: undefined },
  ])('serializes $name clear with an active commit', async ({ tag }) => {
    const world = createWorld({
      dataDir: testDir,
      recoverActiveRuns: false,
      tag,
    });
    const created = await world.journals.commit(
      'session:123',
      new Uint8Array([1]),
      { expectedRevision: null, idempotencyKey: 'create' }
    );

    const [commit, clear] = await Promise.allSettled([
      world.journals.commit('session:123', new Uint8Array([2]), {
        expectedRevision: created.revision,
        idempotencyKey: 'update',
      }),
      world.clear(),
    ]);

    expect(clear.status).toBe('fulfilled');
    const current = await world.journals.get('session:123');
    if (commit.status === 'fulfilled') {
      expect(current === null || current.revision === '2').toBe(true);
    } else {
      expect(commit.reason).toMatchObject({ name: 'EntityConflictError' });
      expect(current).toBeNull();
    }
    await world.close?.();
  });

  it('treats an empty tag as the untagged scope', async () => {
    const emptyTag = createJournals(testDir, '');
    const untagged = createJournals(testDir);
    const created = await emptyTag.commit('session:123', new Uint8Array([1]), {
      expectedRevision: null,
      idempotencyKey: 'create',
    });

    expect(await untagged.get('session:123')).toEqual(created);
  });
});
