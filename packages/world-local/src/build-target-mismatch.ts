import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkflowWorldError } from '@workflow/errors';
import { isVercelDeploymentEnv } from '@workflow/utils';

/**
 * How to get out of a deployment that was built against the wrong world. The
 * target world is resolved when the app is built and compiled into the server
 * bundles, so nothing set at runtime can change it — the build has to be
 * repeated with the target pinned.
 */
const REBUILD_AGAINST_VERCEL_ADVICE =
  'The world is selected when the app is built, not when it runs, so this reflects the build ' +
  'environment: when a build cannot be identified as a Vercel build (for example `vercel build` ' +
  'followed by `vercel deploy --prebuilt`, or a build that runs before Vercel system environment ' +
  'variables are available), set WORKFLOW_TARGET_WORLD=vercel in the build environment and rebuild.';

/**
 * Thrown when the data directory cannot be created because the filesystem
 * rejects the write outright.
 *
 * Without this, the swallowed `mkdir` failure in {@link ensureDir} surfaces one
 * layer later as `ENOENT` on the file being written, which reads like a missing
 * run rather than an unusable data directory.
 */
export class UnwritableDataDirError extends WorkflowWorldError {
  readonly dataDir: string;

  constructor(dataDir: string, code: string) {
    super(
      `[workflow] The local (filesystem) world cannot create its data directory "${dataDir}" (${code}). ` +
        'Workflow runs cannot be stored, so every run will fail before its first step. ' +
        `If this is a Vercel deployment, its filesystem is read-only and the local world cannot work there. ${REBUILD_AGAINST_VERCEL_ADVICE} ` +
        'Otherwise point WORKFLOW_LOCAL_DATA_DIR at a writable directory.',
      { code }
    );
    this.name = 'UnwritableDataDirError';
    this.dataDir = dataDir;
  }

  static is(value: unknown): value is UnwritableDataDirError {
    return value instanceof Error && value.name === 'UnwritableDataDirError';
  }
}

/**
 * `mkdir` failures that mean the directory will never be creatable, as opposed
 * to losing a race with a concurrent writer.
 */
const UNWRITABLE_DIR_CODES = new Set(['EROFS', 'EACCES', 'EPERM']);

export function isUnwritableDirCode(code: string | undefined): boolean {
  return code !== undefined && UNWRITABLE_DIR_CODES.has(code);
}

let warnedAboutVercelDeployment = false;

/** Test seam: the warning is emitted once per process. */
export function resetVercelDeploymentWarning(): void {
  warnedAboutVercelDeployment = false;
}

/**
 * Warn when the local world is created inside a Vercel deployment.
 *
 * A deployment built against the local world writes workflow state to a
 * read-only filesystem, so runs fail before executing a step. Warning at world
 * creation names the cause before the first write does, and covers reads and
 * queue sends that never touch the data directory at all.
 *
 * `/tmp` is exempt: it is writable on Vercel, so a data directory there is a
 * deliberate choice rather than a misconfigured build.
 */
export function warnIfRunningInVercelDeployment(dataDir: string): void {
  if (warnedAboutVercelDeployment || !isVercelDeploymentEnv()) {
    return;
  }
  const resolvedDataDir = path.resolve(dataDir);
  const tmp = tmpdir();
  if (
    resolvedDataDir === tmp ||
    resolvedDataDir.startsWith(`${tmp}${path.sep}`)
  ) {
    return;
  }
  warnedAboutVercelDeployment = true;
  console.warn(
    `[workflow] Warning: the local (filesystem) world is running inside a Vercel deployment, writing to ${resolvedDataDir}. ` +
      'That filesystem is read-only, so workflow runs will fail before their first step. ' +
      REBUILD_AGAINST_VERCEL_ADVICE
  );
}
