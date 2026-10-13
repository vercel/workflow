/**
 * Guidance for runs that failed because they outgrew the default per-run
 * event limit or replay budget. Pure (no React) so every observability UI
 * (the self-hosted web UI and the Vercel dashboard) can share the decision
 * and the copy while rendering it with its own components.
 */

/** Error codes this guidance applies to (`RUN_ERROR_CODES` values). */
const MAX_EVENTS_EXCEEDED = 'MAX_EVENTS_EXCEEDED';
const REPLAY_TIMEOUT = 'REPLAY_TIMEOUT';

const DOCS_BASE_URL = 'https://workflow-sdk.dev/err';

export type RunLimitGuidanceKind = 'max-events-exceeded' | 'replay-timeout';

export interface RunLimitGuidance {
  kind: RunLimitGuidanceKind;
  /** Short heading, e.g. for an alert title. */
  title: string;
  /** One or two sentences explaining what to do. Plain text. */
  description: string;
  /** The env var assignment to suggest, for rendering as code. */
  envVar: string;
  /** Docs page for the error code. */
  docsUrl: string;
}

/**
 * The run fields this guidance reads. Accepts both a hydrated run (where
 * `hydrateResourceIO` lifts `workflowVm` / `snapshotThreshold` out of the
 * stripped `executionContext`) and a raw run (with `executionContext`).
 */
export interface RunLimitGuidanceInput {
  status?: string;
  errorCode?: string | null;
  workflowVm?: unknown;
  snapshotThreshold?: unknown;
  executionContext?: unknown;
}

function readVmPolicy(run: RunLimitGuidanceInput): {
  workflowVm: unknown;
  snapshotThreshold: unknown;
} {
  const ctx =
    run.executionContext && typeof run.executionContext === 'object'
      ? (run.executionContext as Record<string, unknown>)
      : undefined;
  return {
    workflowVm: run.workflowVm ?? ctx?.workflowVm,
    snapshotThreshold: run.snapshotThreshold ?? ctx?.snapshotThreshold,
  };
}

/**
 * Whether the run was started on the QuickJS VM with snapshotting enabled,
 * which exempts it from the default per-run event limit. Mirrors the World
 * policy (`isEventLimitExemptRun` in `@workflow/world`).
 */
export function isQuickJSSnapshotRun(run: RunLimitGuidanceInput): boolean {
  const { workflowVm, snapshotThreshold } = readVmPolicy(run);
  return (
    workflowVm === 'quickjs' &&
    typeof snapshotThreshold === 'number' &&
    Number.isSafeInteger(snapshotThreshold) &&
    snapshotThreshold > 0
  );
}

/**
 * Returns guidance to show for a failed run whose error code is
 * `MAX_EVENTS_EXCEEDED` or `REPLAY_TIMEOUT` and that wasn't already running
 * on the QuickJS VM with snapshotting. Returns `null` otherwise.
 */
export function getRunLimitGuidance(
  run: RunLimitGuidanceInput | null | undefined
): RunLimitGuidance | null {
  if (!run || run.status !== 'failed') return null;
  const code = run.errorCode;
  if (code !== MAX_EVENTS_EXCEEDED && code !== REPLAY_TIMEOUT) return null;
  // Already on the recommended configuration; switching wouldn't help.
  if (isQuickJSSnapshotRun(run)) return null;

  const { workflowVm } = readVmPolicy(run);
  const onQuickJS = workflowVm === 'quickjs';

  const remediation = onQuickJS
    ? "This run used the QuickJS VM, but a snapshot threshold wasn't recorded when it started (snapshotting was disabled, or the run was started by an older SDK), so the default event limit applied. Set a positive WORKFLOW_SNAPSHOT_THRESHOLD in the environment that starts runs, or upgrade the workflow package, so new runs are exempt."
    : 'Run long-running workflows on the QuickJS VM with snapshotting. Snapshotted runs resume without replaying the full event log and are exempt from the default per-run event limit. Set this in the environment that starts runs; only new runs are affected.';

  if (code === MAX_EVENTS_EXCEEDED) {
    return {
      kind: 'max-events-exceeded',
      title: 'This run reached the per-run event limit',
      description: remediation,
      envVar: onQuickJS
        ? 'WORKFLOW_SNAPSHOT_THRESHOLD=1000'
        : 'WORKFLOW_VM=quickjs',
      docsUrl: `${DOCS_BASE_URL}/max-events-exceeded`,
    };
  }
  return {
    kind: 'replay-timeout',
    title: 'This run exceeded the workflow replay time limit',
    description: `Replay time grows with the size of the event log. ${remediation}`,
    envVar: onQuickJS
      ? 'WORKFLOW_SNAPSHOT_THRESHOLD=1000'
      : 'WORKFLOW_VM=quickjs',
    docsUrl: `${DOCS_BASE_URL}/replay-timeout`,
  };
}
