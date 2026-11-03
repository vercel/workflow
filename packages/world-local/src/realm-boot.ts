import { globalSingleton } from '@workflow/utils';

/**
 * When world-local first loaded in this JavaScript realm (process or worker
 * thread). Any step this realm starts is stamped after it, so a stamp at or
 * after it may belong to a live owner here and is never released. A claim
 * file names the boot of the realm that wrote it (see `claim-owner.ts`).
 *
 * On `globalThis` (see `globalSingleton`) so every module copy in the realm
 * shares the earliest load time. `performance.timeOrigin` is not used because
 * Node shares it across a process's worker threads, so it can't mark a reload
 * into a new worker.
 */
export const realmBoot = globalSingleton(
  '@workflow/world-local//realmBoot',
  1,
  () => ({ bootedAt: Date.now() })
);

/**
 * How far a file's mtime may lag the clock that `realmBoot` reads. Linux
 * stamps files from a coarse clock a tick behind `Date.now()`, and some file
 * systems keep whole seconds (or two), so a file written just after a realm
 * booted can carry an earlier mtime. Only a claim that names no writer (an
 * older version's empty claim) is dated by its mtime.
 */
export const FILE_TIME_SLACK_MS = 2_000;
