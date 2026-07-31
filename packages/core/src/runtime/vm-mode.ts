/**
 * VM engine selection for workflow execution.
 *
 * The QuickJS WASM engine is the default. The Node.js `node:vm` engine is
 * opt-in via `WORKFLOW_VM=node` or `executionContext.workflowVm`.
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
 * the known engines — catching misconfiguration early is better than
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
 * The default is the QuickJS engine; `WORKFLOW_VM=node` opts back into
 * the `node:vm` engine.
 *
 * Throws if `WORKFLOW_VM` or `executionContext.workflowVm` is set to an
 * unknown value.
 */
export function useQuickJSVm(workflowRun: WorkflowRun): boolean {
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
  return getWorkflowVmFromEnv() !== 'node';
}

/**
 * Read and validate the `WORKFLOW_SNAPSHOT_THRESHOLD` env var.
 *
 * The threshold is the number of processed events after which the QuickJS
 * engine persists a VM-memory snapshot at suspension, so subsequent
 * invocations restore the VM and replay only the events recorded since —
 * instead of re-executing the workflow from the top against the full log.
 *
 * `0` (or unset) disables snapshotting entirely: short-lived runs never
 * pay the snapshot cost, while long/forever runs can opt in. `1`
 * effectively snapshots at every suspension.
 *
 * Returns the configured threshold, or `undefined` if unset/empty.
 * Throws {@link WorkflowRuntimeError} for non-integer or negative values.
 */
export function getSnapshotThresholdFromEnv(
  env: NodeJS.ProcessEnv = process.env
): number | undefined {
  const raw = env.WORKFLOW_SNAPSHOT_THRESHOLD;
  if (raw === undefined || raw === '') return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
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
 * `0` (disabled). Only consulted by the QuickJS engine.
 */
export function getSnapshotThreshold(workflowRun: WorkflowRun): number {
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
  return getSnapshotThresholdFromEnv() ?? 0;
}
