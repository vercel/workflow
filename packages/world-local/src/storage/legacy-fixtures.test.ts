import { createHash } from 'node:crypto';
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createStorage } from '../storage.js';
import { updateStep } from '../test-helpers.js';
import { convertLayout, resetStoreLayoutState } from './layout.js';

const versions = ['4.1.0', '5.0.0-beta.34', '5.0.0-beta.48', '5.0.2'];
const dirs: string[] = [];
const project = (value: unknown) => JSON.parse(JSON.stringify(value));
type Golden = {
  binaryPayload: number[];
  runs: {
    scenario: string;
    runId: string;
    status: string;
    tag: string | null;
    steps: { stepId: string; status: string }[];
    hooks: { hookId: string; token: string }[];
    eventsListPages: {
      data: Record<string, unknown>[];
      cursor: string;
      hasMore: boolean;
    }[];
  }[];
};
async function fixture(version: string) {
  const root = new URL(
    `../../test/fixtures/legacy/${version}/`,
    import.meta.url
  );
  const dir = await mkdtemp(path.join(tmpdir(), 'legacy-layout-'));
  dirs.push(dir);
  await cp(new URL('data/', root), dir, { recursive: true });
  const golden: Golden = JSON.parse(
    await readFile(new URL('expected.json', root), 'utf8')
  );
  return { dir, golden };
}
async function hashes(
  dir: string,
  prefix = ''
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(path.join(dir, prefix), {
    withFileTypes: true,
  })) {
    const relative = path.join(prefix, entry.name);
    if (relative === '.layout' || relative === 'version.txt') continue;
    if (entry.isDirectory()) Object.assign(result, await hashes(dir, relative));
    else
      result[relative] = createHash('sha256')
        .update(await readFile(path.join(dir, relative)))
        .digest('hex');
  }
  return result;
}
async function readGolden(dir: string, golden: Golden) {
  for (const run of golden.runs) {
    const storage = createStorage(dir, run.tag ?? undefined);
    let cursor: string | undefined;
    for (const expected of run.eventsListPages) {
      const page = await storage.events.list({
        runId: run.runId,
        resolveData: 'all',
        pagination: { limit: 20, sortOrder: 'asc', cursor },
      });
      expect(project(page)).toEqual(expected);
      cursor = page.cursor ?? undefined;
    }
    expect((await storage.runs.get(run.runId)).status).toBe(run.status);
    const steps = await storage.steps.list({
      runId: run.runId,
      resolveData: 'all',
      pagination: { limit: 100, sortOrder: 'asc' },
    });
    expect(
      steps.data.map(({ stepId, status }) => ({ stepId, status }))
    ).toEqual(run.steps);
    for (const step of steps.data) {
      expect(Array.from(step.input as Uint8Array)).toEqual(
        golden.binaryPayload
      );
      if (step.status === 'completed')
        expect(Array.from(step.output as Uint8Array)).toEqual(
          golden.binaryPayload
        );
    }
    for (const hook of run.hooks)
      expect((await storage.hooks.getByToken(hook.token)).hookId).toBe(
        hook.hookId
      );
  }
}
afterEach(async () => {
  await resetStoreLayoutState();
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

describe.each(versions)('published %s flat-store compatibility', (version) => {
  it('reads without rewriting, preserves cursors and tags through migration and rollback', async () => {
    const { dir, golden } = await fixture(version);
    const before = await hashes(dir);
    await readGolden(dir, golden);
    // Reads may add hook indexes, but must not rewrite any published file.
    const after = await hashes(dir);
    for (const [file, hash] of Object.entries(before))
      expect(after[file], file).toBe(hash);
    expect(after['layout.json']).toBeUndefined();
    for (const run of golden.runs)
      expect(await readdir(path.join(dir, 'events'))).not.toContain(run.runId);
    const tagged = golden.runs.find((run) => run.tag);
    if (!tagged) throw new Error('Missing tagged fixture');
    const untaggedBefore = project(
      await createStorage(dir).events.list({
        runId: tagged.runId,
        resolveData: 'all',
      })
    );
    const paginated = golden.runs.find((run) => run.scenario === 'pagination');
    if (!paginated) throw new Error('Missing pagination fixture');
    const oldPage = await createStorage(dir).events.list({
      runId: paginated.runId,
      pagination: {
        limit: 20,
        sortOrder: 'asc',
        cursor: paginated.eventsListPages[0].cursor,
      },
    });
    const count =
      (await readdir(path.join(dir, 'events'))).filter((f) =>
        f.endsWith('.json')
      ).length +
      (await readdir(path.join(dir, 'steps'))).filter((f) =>
        f.endsWith('.json')
      ).length;
    // Stop using the store, as the conversion requires.
    await resetStoreLayoutState();
    expect(await convertLayout(dir, 'run-scoped')).toMatchObject({
      completed: true,
      conflicts: [],
      moved: count,
    });
    await resetStoreLayoutState();
    await readGolden(dir, golden);
    expect(
      project(
        await createStorage(dir).events.list({
          runId: tagged.runId,
          resolveData: 'all',
        })
      )
    ).toEqual(untaggedBefore);
    expect(
      project(
        await createStorage(dir).events.list({
          runId: paginated.runId,
          resolveData: 'all',
          pagination: { limit: 20, sortOrder: 'asc', cursor: oldPage.cursor },
        })
      )
    ).toEqual(paginated.eventsListPages[2]);
    // Stop using the store, as the conversion requires.
    await resetStoreLayoutState();
    expect(await convertLayout(dir, 'flat')).toMatchObject({
      completed: true,
      conflicts: [],
    });
    expect(await hashes(dir)).toEqual(after);
  });

  it('resumes an interrupted migration only through explicit conversion', async () => {
    const { dir, golden } = await fixture(version);
    const files = (await readdir(path.join(dir, 'events'))).filter((f) =>
      f.endsWith('.json')
    );
    for (const file of files.slice(0, Math.ceil(files.length / 2))) {
      const run = golden.runs.find((r) => file.startsWith(`${r.runId}-`));
      if (!run) throw new Error(`Unknown fixture event ${file}`);
      await mkdir(path.join(dir, 'events', run.runId), { recursive: true });
      await rename(
        path.join(dir, 'events', file),
        path.join(dir, 'events', run.runId, file)
      );
    }
    await writeFile(
      path.join(dir, 'layout.json'),
      JSON.stringify({
        schema: 1,
        state: 'migrating',
        updatedAt: new Date().toISOString(),
      })
    );
    await expect(
      createStorage(dir).events.list({ runId: golden.runs[0].runId })
    ).rejects.toMatchObject({ code: 'CONVERSION_IN_PROGRESS' });
    // Stop using the store, as the conversion requires.
    await resetStoreLayoutState();
    expect(await convertLayout(dir, 'run-scoped')).toMatchObject({
      completed: true,
      conflicts: [],
    });
    await resetStoreLayoutState();
    await readGolden(dir, golden);
  });

  it('continues an in-flight run with monotonic unique identities and inline deltas', async () => {
    const { dir, golden } = await fixture(version);
    const run = golden.runs.find((r) => r.scenario === 'in-flight');
    if (!run) throw new Error('Missing in-flight fixture');
    // Stop using the store, as the conversion requires.
    await resetStoreLayoutState();
    expect((await convertLayout(dir, 'run-scoped')).completed).toBe(true);
    await resetStoreLayoutState();
    const storage = createStorage(dir);
    const prior = await storage.events.list({
      runId: run.runId,
      pagination: { sortOrder: 'asc' },
    });
    await updateStep(
      storage,
      run.runId,
      run.steps[0].stepId,
      'step_completed',
      { result: new Uint8Array(golden.binaryPayload) }
    );
    const result = await storage.events.create(
      run.runId,
      {
        eventType: 'run_completed',
        eventData: { output: new Uint8Array(golden.binaryPayload) },
      },
      { sinceCursor: prior.cursor ?? undefined }
    );
    expect(result.events?.map((e) => e.eventType)).toEqual([
      'step_completed',
      'run_completed',
    ]);
    const delta = await storage.events.list({
      runId: run.runId,
      pagination: { sortOrder: 'asc', cursor: prior.cursor },
    });
    expect(result.events?.map((e) => e.eventId)).toEqual(
      delta.data.map((e) => e.eventId)
    );
    const all = await storage.events.list({
      runId: run.runId,
      pagination: { sortOrder: 'asc' },
    });
    const ids = all.data.map((e) => e.eventId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...ids].sort());
    expect((await storage.runs.get(run.runId)).status).toBe('completed');
  });
});
