// Subprocess worker used by `storage.test.ts` to exercise the cross-
// process `hook_created` convergence path. Each worker creates its own
// `createStorage(testDir)` instance — distinct from the parent and
// from other workers — so it has an independent in-process
// `hookLocks` map. The shared on-disk token claim / recovery marker /
// event publish is what arbitrates between workers.
//
// Protocol over Node IPC:
//   parent → worker: `'go'` (release the barrier)
//   worker → parent: `{ status: 'ready' }` once the storage is loaded
//                    and the message listener is wired up; then either
//                    `{ status: 'fulfilled', eventId, eventType }` or
//                    `{ status: 'rejected', errorName, errorMessage }`.
//
// Invoked via `child_process.fork(...) { execPath: tsx }` so this
// TypeScript file runs without a pre-build step.

import { createStorage } from '../src/storage.js';

const [basedir, runId, hookId, token] = process.argv.slice(2);

if (!basedir || !runId || !hookId || !token) {
  throw new Error(
    'hook-race-worker requires args: <basedir> <runId> <hookId> <token>'
  );
}

process.on('message', async (msg) => {
  if (msg !== 'go') return;
  const storage = createStorage(basedir);
  try {
    const result = await storage.events.create(runId, {
      eventType: 'hook_created',
      correlationId: hookId,
      eventData: { token },
    });
    process.send?.({
      status: 'fulfilled',
      eventId: result.event.eventId,
      eventType: result.event.eventType,
    });
  } catch (err: unknown) {
    const e = err as { name?: string; message?: string };
    process.send?.({
      status: 'rejected',
      errorName: e?.name ?? 'UnknownError',
      errorMessage: e?.message ?? String(err),
    });
  }
  process.exit(0);
});

process.send?.({ status: 'ready' });
