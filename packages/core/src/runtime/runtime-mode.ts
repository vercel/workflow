/**
 * Runtime mode selection for workflow execution.
 *
 * The `node-vm` runtime (the default) executes workflow orchestrator code in a
 * Node.js `vm` context. The `quickjs` runtime executes it inside a QuickJS WASM
 * VM instead — this is required on runtimes that disallow `node:vm` /
 * code-generation-from-strings (e.g. Cloudflare Workers).
 *
 * The QuickJS runtime is opt-in via the `WORKFLOW_RUNTIME` env var or
 * per-run via `executionContext.workflowRuntime` (set by the SDK at start()),
 * so the same deployment can serve both.
 */

import { WorkflowRuntimeError } from '@workflow/errors';

/**
 * Known workflow runtime modes. Any other `WORKFLOW_RUNTIME` value is
 * treated as a misconfiguration and rejected at startup.
 */
export const WORKFLOW_RUNTIMES = ['node-vm', 'quickjs'] as const;

export type WorkflowRuntimeMode = (typeof WORKFLOW_RUNTIMES)[number];

/** The runtime used when nothing overrides it. */
export const DEFAULT_WORKFLOW_RUNTIME: WorkflowRuntimeMode = 'node-vm';

/**
 * Read and validate the `WORKFLOW_RUNTIME` env var.
 *
 * Returns the configured mode, or `undefined` if unset/empty.
 * Throws {@link WorkflowRuntimeError} if the value is set but not one of
 * the known modes — catching misconfiguration early is better than
 * silently falling back to the default.
 */
export function getWorkflowRuntimeFromEnv(
  env: NodeJS.ProcessEnv = process.env
): WorkflowRuntimeMode | undefined {
  const raw = env.WORKFLOW_RUNTIME;
  if (raw === undefined || raw === '') return undefined;
  if ((WORKFLOW_RUNTIMES as readonly string[]).includes(raw)) {
    return raw as WorkflowRuntimeMode;
  }
  throw new WorkflowRuntimeError(
    `Invalid WORKFLOW_RUNTIME value: "${raw}". ` +
      `Expected one of: ${WORKFLOW_RUNTIMES.join(', ')}.`
  );
}
