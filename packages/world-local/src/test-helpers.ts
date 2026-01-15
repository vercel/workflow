import type { Hook, Step, Storage, WorkflowRun } from '@workflow/world';

/**
 * Test helper functions for creating and updating storage entities through events.
 * These helpers simplify test setup by providing a convenient API for common operations.
 */

/**
 * Create a new workflow run through the run_created event.
 */
export async function createRun(
  storage: Storage,
  data: {
    deploymentId: string;
    workflowName: string;
    input: unknown[];
    executionContext?: Record<string, unknown>;
  }
): Promise<WorkflowRun> {
  const result = await storage.events.create(null, {
    eventType: 'run_created',
    eventData: data,
  });
  if (!result.run) {
    throw new Error('Expected run to be created');
  }
  return result.run;
}

/**
 * Update a workflow run's status through lifecycle events.
 */
export async function updateRun(
  storage: Storage,
  runId: string,
  eventType: 'run_started' | 'run_completed' | 'run_failed',
  eventData?: Record<string, unknown>
): Promise<WorkflowRun> {
  const result = await storage.events.create(runId, {
    eventType,
    eventData,
  } as any);
  if (!result.run) {
    throw new Error('Expected run to be updated');
  }
  return result.run;
}

/**
 * Create a new step through the step_created event.
 */
export async function createStep(
  storage: Storage,
  runId: string,
  data: {
    stepId: string;
    stepName: string;
    input: unknown[];
  }
): Promise<Step> {
  const result = await storage.events.create(runId, {
    eventType: 'step_created',
    correlationId: data.stepId,
    eventData: { stepName: data.stepName, input: data.input },
  });
  if (!result.step) {
    throw new Error('Expected step to be created');
  }
  return result.step;
}

/**
 * Update a step's status through lifecycle events.
 */
export async function updateStep(
  storage: Storage,
  runId: string,
  stepId: string,
  eventType: 'step_started' | 'step_completed' | 'step_failed',
  eventData?: Record<string, unknown>
): Promise<Step> {
  const result = await storage.events.create(runId, {
    eventType,
    correlationId: stepId,
    eventData,
  } as any);
  if (!result.step) {
    throw new Error('Expected step to be updated');
  }
  return result.step;
}

/**
 * Create a new hook through the hook_created event.
 */
export async function createHook(
  storage: Storage,
  runId: string,
  data: {
    hookId: string;
    token: string;
    metadata?: unknown;
  }
): Promise<Hook> {
  const result = await storage.events.create(runId, {
    eventType: 'hook_created',
    correlationId: data.hookId,
    eventData: { token: data.token, metadata: data.metadata },
  });
  if (!result.hook) {
    throw new Error('Expected hook to be created');
  }
  return result.hook;
}

/**
 * Dispose a hook through the hook_disposed event.
 */
export async function disposeHook(
  storage: Storage,
  runId: string,
  hookId: string
): Promise<void> {
  await storage.events.create(runId, {
    eventType: 'hook_disposed',
    correlationId: hookId,
  });
}
