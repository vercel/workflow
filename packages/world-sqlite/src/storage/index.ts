import type { Storage } from '@workflow/world';
import { instrumentObject } from '@workflow/world-local';
import type { Db } from '../db.js';
import { purgeRunStreamData } from '../streamer.js';
import type { Ctx } from './common.js';
import { createEventsStorage } from './events.js';
import { createHooksStorage } from './hooks.js';
import { createRunsStorage } from './runs.js';
import { createSnapshotsStorage } from './snapshots.js';
import { createStepsStorage } from './steps.js';

export type SqliteStorage = Storage & {
  experimental_snapshots: ReturnType<typeof createSnapshotsStorage>;
};

export function createStorage(db: Db, tag?: string): SqliteStorage {
  const ctx: Ctx = { db, tag: tag ?? '' };
  const events = createEventsStorage(ctx, {
    purgeRunStreams: (runId) => purgeRunStreamData(db, runId, ctx.tag),
  });
  return {
    runs: instrumentObject('world.runs', createRunsStorage(ctx)),
    steps: instrumentObject('world.steps', createStepsStorage(ctx)),
    events: instrumentObject('world.events', events),
    hooks: instrumentObject('world.hooks', createHooksStorage(ctx)),
    experimental_snapshots: instrumentObject(
      'world.experimental_snapshots',
      createSnapshotsStorage(ctx)
    ),
  };
}
