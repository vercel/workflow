/**
 * VM engine selection for workflow execution.
 *
 * The Node.js `node:vm` engine is the default. The QuickJS WASM engine is
 * opt-in via the `WORKFLOW_VM` env var or `executionContext.workflowVm`.
 *
 * Both engines implement the same event-replay execution model: on every
 * workflow handler invocation the workflow function is re-executed from the
 * top and the recorded event log resolves awaited primitives. The QuickJS
 * engine runs the workflow code in a QuickJS WASM VM (via quickjs-wasi)
 * instead of a `node:vm` context, which makes it usable on platforms that
 * do not implement `node:vm` (e.g. Cloudflare Workers) and is the
 * foundation for VM-memory snapshotting.
 */

import { WorkflowRuntimeError } from '@workflow/errors';
import type { WorkflowRun } from '@workflow/world';

/**
 * Known workflow VM engines. Any other `WORKFLOW_VM` value is treated as
 * a misconfiguration and rejected at startup.
 */
export const WORKFLOW_VMS = ['node', 'quickjs'] as const;

export type WorkflowVmMode = (typeof WORKFLOW_VMS)[number];

/**
 * Read and validate the `WORKFLOW_VM` env var.
 *
 * Returns the configured engine, or `undefined` if unset/empty.
 * Throws {@link WorkflowRuntimeError} if the value is set but not one of
 * the known engines, since catching misconfiguration early is better than
 * silently falling back to the default.
 */
export function getWorkflowVmFromEnv(
  env: NodeJS.ProcessEnv = process.env
): WorkflowVmMode | undefined {
  const raw = env.WORKFLOW_VM;
  if (raw === undefined || raw === '') return undefined;
  if ((WORKFLOW_VMS as readonly string[]).includes(raw)) {
    return raw as WorkflowVmMode;
  }
  throw new WorkflowRuntimeError(
    `Invalid WORKFLOW_VM value: "${raw}". ` +
      `Expected one of: ${WORKFLOW_VMS.join(', ')}.`
  );
}

/**
 * Whether to use the QuickJS WASM VM for a given run.
 *
 * The run's `executionContext.workflowVm` (stamped by the SDK at `start()`
 * when `WORKFLOW_VM` is set on the client) takes precedence so a run keeps
 * executing on the engine it started on. When the run doesn't specify an
 * engine, the `WORKFLOW_VM` env var on the workflow handler decides.
 * The default is the `node:vm` engine.
 *
 * Throws if `WORKFLOW_VM` or `executionContext.workflowVm` is set to an
 * unknown value.
 */
export function useQuickJSVm(
  workflowRun: Pick<WorkflowRun, 'executionContext'>
): boolean {
  const vmFromRun = (
    workflowRun.executionContext as { workflowVm?: string } | undefined
  )?.workflowVm;
  if (vmFromRun !== undefined) {
    if (!(WORKFLOW_VMS as readonly string[]).includes(vmFromRun)) {
      throw new WorkflowRuntimeError(
        `Invalid executionContext.workflowVm value: "${vmFromRun}". ` +
          `Expected one of: ${WORKFLOW_VMS.join(', ')}.`
      );
    }
    return vmFromRun === 'quickjs';
  }
  return getWorkflowVmFromEnv() === 'quickjs';
}

/**
 * Snapshot threshold the QuickJS engine uses when neither the run's
 * `executionContext` nor `WORKFLOW_SNAPSHOT_THRESHOLD` specifies one.
 * Short runs (most workflows) never reach it and so never pay the
 * snapshot cost; long-running runs stop scaling their resume cost with
 * total event-log length. Set `WORKFLOW_SNAPSHOT_THRESHOLD=0` to opt out.
 */
export const DEFAULT_QUICKJS_SNAPSHOT_THRESHOLD = 1000;

/**
 * Read and validate the `WORKFLOW_SNAPSHOT_THRESHOLD` env var.
 *
 * The threshold is the number of processed events after which the QuickJS
 * engine persists a VM-memory snapshot at suspension, so subsequent
 * invocations restore the VM and replay only the events recorded since —
 * instead of re-executing the workflow from the top against the full log.
 *
 * When unset, the QuickJS engine uses
 * {@link DEFAULT_QUICKJS_SNAPSHOT_THRESHOLD}. `0` explicitly disables
 * snapshotting. `1` effectively snapshots at every suspension.
 *
 * Returns the configured threshold, or `undefined` if unset/empty.
 * Throws {@link WorkflowRuntimeError} for non-integer or negative values.
 */
export function getSnapshotThresholdFromEnv(
  env: NodeJS.ProcessEnv = process.env
): number | undefined {
  const raw = env.WORKFLOW_SNAPSHOT_THRESHOLD;
  if (raw === undefined || raw === '') return undefined;
  // Digits only: `Number()` would also accept "1e3", "0x10" and " 5 ".
  const parsed = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(parsed)) {
    throw new WorkflowRuntimeError(
      `Invalid WORKFLOW_SNAPSHOT_THRESHOLD value: "${raw}". ` +
        'Expected a non-negative integer (0 disables snapshotting).'
    );
  }
  return parsed;
}

/**
 * Resolve the snapshot threshold for a run: the run's stamped
 * `executionContext.snapshotThreshold` (set by the SDK at `start()` when
 * `WORKFLOW_SNAPSHOT_THRESHOLD` is set on the client) wins so a run keeps
 * the policy it started with; otherwise the handler's env var; otherwise
 * {@link DEFAULT_QUICKJS_SNAPSHOT_THRESHOLD}. Only consulted by the QuickJS
 * engine.
 *
 * Throws on an invalid value. The workflow handler uses
 * {@link getSnapshotThresholdForHandler}, which doesn't.
 */
export function getSnapshotThreshold(workflowRun: WorkflowRun): number {
  return (
    getConfiguredSnapshotThreshold(workflowRun) ??
    DEFAULT_QUICKJS_SNAPSHOT_THRESHOLD
  );
}

/**
 * The snapshot threshold explicitly configured for a run (stamped into its
 * `executionContext` or set via `WORKFLOW_SNAPSHOT_THRESHOLD` on the
 * handler), or `undefined` when the run falls back to
 * {@link DEFAULT_QUICKJS_SNAPSHOT_THRESHOLD}.
 *
 * Throws on an invalid value.
 */
export function getConfiguredSnapshotThreshold(
  workflowRun: WorkflowRun
): number | undefined {
  const fromRun = (
    workflowRun.executionContext as { snapshotThreshold?: unknown } | undefined
  )?.snapshotThreshold;
  if (fromRun !== undefined) {
    if (
      typeof fromRun !== 'number' ||
      !Number.isInteger(fromRun) ||
      fromRun < 0
    ) {
      throw new WorkflowRuntimeError(
        `Invalid executionContext.snapshotThreshold value: "${fromRun}". ` +
          'Expected a non-negative integer.'
      );
    }
    return fromRun;
  }
  return getSnapshotThresholdFromEnv();
}

/**
 * Whether the run's snapshot threshold was explicitly configured rather
 * than falling back to {@link DEFAULT_QUICKJS_SNAPSHOT_THRESHOLD}. Never
 * throws: an invalid value counts as configured.
 */
export function isSnapshotThresholdConfigured(
  workflowRun: WorkflowRun
): boolean {
  try {
    return getConfiguredSnapshotThreshold(workflowRun) !== undefined;
  } catch {
    return true;
  }
}

/**
 * {@link getSnapshotThreshold} for the workflow handler: an invalid value
 * disables snapshotting (with a warning through `onInvalid`) instead of
 * throwing. Snapshotting is an optimization, and a throw here would fail
 * every invocation of every QuickJS run on the deployment into a retry
 * loop over a config typo. `start()` still rejects an invalid client-side
 * value up front.
 */
export function getSnapshotThresholdForHandler(
  workflowRun: WorkflowRun,
  onInvalid: (message: string) => void
): number {
  try {
    return getSnapshotThreshold(workflowRun);
  } catch (err) {
    onInvalid((err as Error).message);
    return 0;
  }
}

/**
 * Whether `WORKFLOW_SNAPSHOT_ALLOW_UNENCRYPTED` opts the handler into
 * persisting VM snapshots for runs without an encryption key. A snapshot is
 * executable VM state that also holds the run's in-memory data, so by
 * default the runtime only snapshots runs whose World supplies an
 * encryption key (which also authenticates the snapshot on restore).
 */
export function isUnencryptedSnapshottingAllowed(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const raw = env.WORKFLOW_SNAPSHOT_ALLOW_UNENCRYPTED;
  return raw === '1' || raw === 'true';
}
