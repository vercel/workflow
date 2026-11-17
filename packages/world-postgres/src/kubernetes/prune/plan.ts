import type { VersionBacklog } from '../backlog-handler.js';

/** One version's worker Deployment, as listed from the cluster. */
export interface WorkerDeployment {
  readonly name: string;
  readonly version: string;
  readonly createdAt: Date;
}

export interface PrunePlanInput {
  readonly now: Date;
  readonly workers: readonly WorkerDeployment[];
  /**
   * Versions that may still start runs, so their workers stay whatever their
   * backlog says: the version being deployed, the main Deployment's version,
   * and the version of every ReplicaSet of it that still has pods.
   */
  readonly protectedVersions: ReadonlySet<string>;
  /** Each worker's backlog, or the error reading it. */
  readonly backlogs: ReadonlyMap<string, VersionBacklog | Error>;
  /** Versions with runs that have not finished, or the error listing them. */
  readonly activeVersions: ReadonlyMap<string, number> | Error;
  /** Workers younger than this are kept: their version may not have started runs yet. */
  readonly minAgeMs: number;
}

type KeepReason = 'protected' | 'young' | 'active-runs' | 'backlog-unavailable';

export type PruneAction =
  | {
      readonly kind: 'keep';
      readonly worker: WorkerDeployment;
      readonly reason: KeepReason;
    }
  | { readonly kind: 'delete'; readonly worker: WorkerDeployment }
  /** A version has unfinished runs but no workers: recreate them. */
  | {
      readonly kind: 'restore';
      readonly version: string;
      readonly activeRuns: number;
    };

/**
 * Decides which versions' workers to delete, keep and restore. Deleting is the
 * only irreversible action, so it needs every signal to agree: the version is
 * not protected, its workers are old enough, its backlog was read, and it has
 * no unfinished runs. Anything unknown keeps the workers.
 */
export function planPrune(input: PrunePlanInput): PruneAction[] {
  const actions: PruneAction[] = [];
  const withWorkers = new Set<string>();

  for (const worker of input.workers) {
    withWorkers.add(worker.version);
    const backlog = input.backlogs.get(worker.version);
    const active =
      input.activeVersions instanceof Error
        ? undefined
        : (input.activeVersions.get(worker.version) ?? 0);

    let reason: KeepReason | undefined;
    if (input.protectedVersions.has(worker.version)) {
      reason = 'protected';
    } else if (
      input.now.getTime() - worker.createdAt.getTime() <
      input.minAgeMs
    ) {
      reason = 'young';
    } else if (
      backlog === undefined ||
      backlog instanceof Error ||
      active === undefined
    ) {
      reason = 'backlog-unavailable';
    } else if (backlog.activeRuns > 0 || active > 0) {
      reason = 'active-runs';
    }

    actions.push(
      reason ? { kind: 'keep', worker, reason } : { kind: 'delete', worker }
    );
  }

  if (!(input.activeVersions instanceof Error)) {
    for (const [version, activeRuns] of input.activeVersions) {
      if (activeRuns > 0 && !withWorkers.has(version)) {
        actions.push({ kind: 'restore', version, activeRuns });
      }
    }
  }

  return actions;
}
