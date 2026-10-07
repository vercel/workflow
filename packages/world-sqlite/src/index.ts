import path from 'node:path';
import type { QueuePrefix, World } from '@workflow/world';
import { mintedSpecVersion, reenqueueActiveRuns } from '@workflow/world';
import {
  createQueue,
  type DirectHandler,
  instrumentObject,
  type LocalWorldConfig,
} from '@workflow/world-local';
import { Db } from './db.js';
import { createStorage } from './storage/index.js';
import { createStreamer } from './streamer.js';

export {
  compareVersions,
  MIN_SQLITE_VERSION,
  SCHEMA_VERSION,
  SqliteUnavailableError,
  SqliteVersionError,
} from './db.js';
export { UnsafeEntityIdError } from './storage/common.js';

export type Config = LocalWorldConfig & {
  /**
   * SQLite database file. Defaults to `$WORKFLOW_SQLITE_PATH`, else
   * `<dataDir>/workflow.sqlite`.
   */
  dbPath?: string;
};

export type SqliteWorld = World & {
  registerHandler(prefix: QueuePrefix, handler: DirectHandler): void;
  clear(): Promise<void>;
  /** Absolute path of the database file. */
  readonly dbPath: string;
};

function resolveRecoverActiveRuns(config: Partial<Config>): boolean {
  if (config.recoverActiveRuns !== undefined) return config.recoverActiveRuns;
  const raw = process.env.WORKFLOW_LOCAL_RECOVER_ACTIVE_RUNS?.toLowerCase();
  return !(raw === '0' || raw === 'false');
}

const ENTITY_TABLES = [
  'runs',
  'events',
  'steps',
  'hooks',
  'waits',
  'stream_chunks',
  'run_streams',
] as const;

export function createWorld(args?: Partial<Config>): SqliteWorld {
  const definedArgs = args
    ? Object.fromEntries(
        Object.entries(args).filter(([, value]) => value !== undefined)
      )
    : {};
  const config: Config = {
    dataDir: process.env.WORKFLOW_LOCAL_DATA_DIR || '.workflow-data',
    baseUrl: process.env.WORKFLOW_LOCAL_BASE_URL,
    ...definedArgs,
  };
  const dbPath = path.resolve(
    config.dbPath ??
      process.env.WORKFLOW_SQLITE_PATH ??
      path.join(config.dataDir, 'workflow.sqlite')
  );
  const tag = config.tag || undefined;
  const tagValue = tag ?? '';

  // Opening checks the SQLite version and creates the schema, so a store
  // this runtime can't safely share fails here, at startup.
  const db = new Db(dbPath);
  const queue = createQueue(config);
  const storage = createStorage(db, tag);
  const recoverActiveRuns = resolveRecoverActiveRuns(config);

  function clearTagged(): void {
    db.transaction(() => {
      const tokens = db.all<{ token: string }>(
        'SELECT token FROM hooks WHERE tag = ?',
        tagValue
      );
      for (const { token } of tokens) {
        db.run('DELETE FROM hook_tokens WHERE token = ?', token);
      }
      db.run(
        'DELETE FROM hook_resumes WHERE run_id IN (SELECT run_id FROM runs WHERE tag = ?)',
        tagValue
      );
      for (const table of ENTITY_TABLES) {
        db.run(`DELETE FROM ${table} WHERE tag = ?`, tagValue);
      }
      // Every claim this instance writes carries its `.<tag>` suffix.
      const suffix = `.${tagValue}`;
      db.run(
        'DELETE FROM locks WHERE length(name) > length(?) AND substr(name, -length(?)) = ?',
        suffix,
        suffix,
        suffix
      );
    });
  }

  function clearAll(): void {
    db.transaction(() => {
      for (const table of [
        ...ENTITY_TABLES,
        'hook_tokens',
        'hook_resumes',
        'locks',
        'snapshots',
      ]) {
        db.run(`DELETE FROM ${table}`);
      }
    });
    // Hand the freed pages back so a cleared store is small again.
    db.raw.exec('VACUUM');
  }

  return {
    specVersion: mintedSpecVersion(),
    capabilities: {
      hookRetention: { active: true },
      dynamicWorkflowCode: true,
      hookResumeDedup: true,
      hookForceClaim: true,
    },
    dbPath,
    ...queue,
    ...storage,
    ...instrumentObject('world.streams', {
      ...createStreamer(db, tag),
      ...(config.streamFlushIntervalMs !== undefined && {
        streamFlushIntervalMs: config.streamFlushIntervalMs,
      }),
    }),
    async start() {
      if (!recoverActiveRuns) return;
      const recoveryRuns = {
        ...storage.runs,
        list: ((params) =>
          storage.runs.list({
            ...params,
            ownTagOnly: true,
          } as any)) as typeof storage.runs.list,
      };
      await reenqueueActiveRuns(recoveryRuns, queue.queue, 'world-sqlite');
    },
    async close() {
      await queue.close();
      db.close();
    },
    async clear() {
      if (tag) clearTagged();
      else clearAll();
    },
  };
}

export default createWorld;
