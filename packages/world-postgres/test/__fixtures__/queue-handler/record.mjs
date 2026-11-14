// Records `expected.json` from `@workflow/world-local`'s queue handler, the
// one the Postgres World used until it got its own. Run from this directory
// in the monorepo, with `@workflow/world-local` built:
//
//   node record.mjs
//
// The Postgres World does not depend on `@workflow/world-local`, so the
// package is loaded by its path in the monorepo.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCases } from './cases.mjs';

const { createWorld } = await import('../../../../world-local/dist/index.js');

const dataDir = await mkdtemp(join(tmpdir(), 'queue-handler-record-'));
const world = createWorld({ dataDir, queueAuthKey: 'read' });
try {
  const results = await runCases(world.createQueueHandler);
  await writeFile(
    new URL('./expected.json', import.meta.url),
    `${JSON.stringify(
      {
        recordedFrom:
          "@workflow/world-local createQueueHandler, before the Postgres World's own handler",
        results,
      },
      null,
      2
    )}\n`
  );
  console.log(`recorded ${Object.keys(results).length} cases`);
} finally {
  await world.close?.();
  await rm(dataDir, { recursive: true, force: true });
}
