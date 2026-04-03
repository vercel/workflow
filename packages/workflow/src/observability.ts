/**
 * Observability utilities for hydrating serialized workflow data.
 *
 * Use these when inspecting workflow step I/O, run inputs/outputs,
 * or event data from the Workflow SDK's world APIs.
 *
 * @example
 * ```ts
 * import { getWorld } from 'workflow/api';
 * import { hydrateResourceIO, observabilityRevivers } from 'workflow/observability';
 *
 * const world = await getWorld();
 * const step = await world.steps.get(runId, stepId, { resolveData: 'all' });
 * const hydrated = hydrateResourceIO(step, observabilityRevivers);
 * // hydrated.input and hydrated.output are now plain JS objects
 * ```
 */
export {
  hydrateData,
  hydrateResourceIO,
  observabilityRevivers,
  type Revivers,
} from '@workflow/core/serialization-format';

export {
  parseClassName,
  parseStepName,
  parseWorkflowName,
} from '@workflow/utils';
