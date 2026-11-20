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
  /**
   * The versions' ScaledObjects, as listed from the cluster. A kept worker
   * without one is never scaled, so it is repaired; a ScaledObject without a
   * worker is deleted once its version has drained. Omitted: every worker is
   * assumed to have one, and none is orphaned.
   */
  readonly scalers?: readonly WorkerDeployment[];
}

type KeepReason = 'protected' | 'young' | 'active-runs' | 'backlog-unavailable';

export type PruneAction =
  | {
      readonly kind: 'keep';
      readonly worker: WorkerDeployment;
      readonly reason: KeepReason;
    }
  | { readonly kind: 'delete'; readonly worker: WorkerDeployment }
  /** A kept worker has no ScaledObject: recreate it. */
  | { readonly kind: 'repair'; readonly worker: WorkerDeployment }
  /** A drained version's ScaledObject outlived its worker: delete it. */
  | { readonly kind: 'delete-scaler'; readonly scaler: WorkerDeployment }
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
  const scaled = input.scalers && new Set(input.scalers.map((s) => s.version));

  const active = (version: string) =>
    input.activeVersions instanceof Error
      ? undefined
      : (input.activeVersions.get(version) ?? 0);

  /** Why a version's resources must stay, or `undefined` when they may go. */
  const keepReason = (
    version: string,
    createdAt: Date,
    backlog: VersionBacklog | Error | undefined
  ): KeepReason | undefined => {
    const runs = active(version);
    if (input.protectedVersions.has(version)) return 'protected';
    if (input.now.getTime() - createdAt.getTime() < input.minAgeMs) {
      return 'young';
    }
    if (
      backlog === undefined ||
      backlog instanceof Error ||
      runs === undefined
    ) {
      return 'backlog-unavailable';
    }
    if (backlog.activeRuns > 0 || runs > 0) return 'active-runs';
    return undefined;
  };

  for (const worker of input.workers) {
    withWorkers.add(worker.version);
    const reason = keepReason(
      worker.version,
      worker.createdAt,
      input.backlogs.get(worker.version)
    );
    if (!reason) {
      actions.push({ kind: 'delete', worker });
      continue;
    }
    actions.push({ kind: 'keep', worker, reason });
    if (scaled && !scaled.has(worker.version)) {
      actions.push({ kind: 'repair', worker });
    }
  }

  if (!(input.activeVersions instanceof Error)) {
    for (const [version, activeRuns] of input.activeVersions) {
      if (activeRuns > 0 && !withWorkers.has(version)) {
        actions.push({ kind: 'restore', version, activeRuns });
      }
    }
  }

  // A ScaledObject whose worker is gone: a version with unfinished runs gets
  // its worker restored above; a drained one loses the ScaledObject too.
  for (const scaler of input.scalers ?? []) {
    if (withWorkers.has(scaler.version)) continue;
    const backlog: VersionBacklog | undefined =
      active(scaler.version) === undefined
        ? undefined
        : {
            version: scaler.version,
            activeRuns: active(scaler.version) ?? 0,
            dueDeliveries: 0,
            wanted: 0,
          };
    if (!keepReason(scaler.version, scaler.createdAt, backlog)) {
      actions.push({ kind: 'delete-scaler', scaler });
    }
  }

  return actions;
}
