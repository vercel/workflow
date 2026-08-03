import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkflowWorldError } from '@workflow/errors';

/**
 * How to get out of a deployment running against the wrong world. The world is
 * resolved from the environment when the process starts, so this is fixed by
 * the deployment's environment variables rather than by rebuilding.
 */
const SELECT_VERCEL_WORLD_ADVICE =
  'The world is selected from the environment when the process starts: the Vercel world is used ' +
  'when VERCEL_DEPLOYMENT_ID is set, unless WORKFLOW_TARGET_WORLD says otherwise. Unset ' +
  'WORKFLOW_TARGET_WORLD in this deployment, or set WORKFLOW_TARGET_WORLD=vercel, to use the ' +
  'Vercel world.';

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
        `If this is a Vercel deployment, its filesystem is read-only and the local world cannot work there. ${SELECT_VERCEL_WORLD_ADVICE} ` +
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
 * A deployment running the local world writes workflow state to a read-only
 * filesystem, so runs fail before executing a step. Warning at world creation
 * names the cause before the first write does, and covers reads and queue sends
 * that never touch the data directory at all.
 *
 * `VERCEL_DEPLOYMENT_ID` is the only signal used, because it is the only one
 * that means "inside a deployment": `VERCEL=1` also shows up in local processes
 * that loaded an env file from `vercel env pull`, where the filesystem is
 * writable and the local world is the right choice.
 *
 * `/tmp` is exempt: it is writable on Vercel, so a data directory there is a
 * deliberate choice rather than a misconfiguration.
 */
export function warnIfRunningInVercelDeployment(dataDir: string): void {
  if (warnedAboutVercelDeployment || !process.env.VERCEL_DEPLOYMENT_ID) {
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
      SELECT_VERCEL_WORLD_ADVICE
  );
}
