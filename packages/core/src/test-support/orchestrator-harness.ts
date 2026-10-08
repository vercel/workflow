import type { Event, WorkflowRun } from '@workflow/world';
import { setWorld } from '../runtime/world.js';
import { workflowEntrypoint } from '../runtime.js';
import {
  dehydrateWorkflowArguments,
  hydrateWorkflowReturnValue,
} from '../serialization.js';
import { AppendOnlyWorld, type HeldMessage } from './append-only-world.js';

/** The orchestrator queue of a workflow named `workflow`. */
export const ORCHESTRATOR_QUEUE = '__wkf_workflow_workflow';

/** Registers `name` as the workflow of a test's workflow code. */
export function registerWorkflow(name = 'workflow'): string {
  return `;globalThis.__private_workflows = new Map([[${JSON.stringify(name)}, ${name}]]);`;
}

/**
 * Seeds a run of `code` on a fresh {@link AppendOnlyWorld}, installs it as the
 * World, registers the queue handler, and enqueues the run's start message
 * (not delivered).
 */
export async function setupOrchestratorRun(
  code: string,
  args: unknown[],
  options: ConstructorParameters<typeof AppendOnlyWorld>[0] = {},
  engine: 'node' | 'quickjs' = 'node'
) {
  const runId = `wrun_so_${Math.random().toString(36).slice(2)}`;
  const world = new AppendOnlyWorld(options);
  world.seedRun({
    runId,
    workflowName: 'workflow',
    deploymentId: 'dpl_test',
    status: 'pending',
    executionContext: { workflowVm: engine },
    input: await dehydrateWorkflowArguments(args, runId, undefined, []),
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as WorkflowRun);
  setWorld(world.asWorld());
  await workflowEntrypoint(code)(new Request('https://example.test'));
  const start = world.enqueue(ORCHESTRATOR_QUEUE, {
    runId,
    requestedAt: new Date(),
  });
  return { world, runId, start };
}

export const eventsOf = (world: AppendOnlyWorld, type: string) =>
  world.events.filter((event) => event.eventType === type);

export const dataOf = (event: Event | undefined) =>
  (event as { eventData?: Record<string, unknown> } | undefined)?.eventData;

/** The hydrated return value of the run's `run_completed`, if any. */
export async function runResult(world: AppendOnlyWorld): Promise<unknown> {
  const completed = eventsOf(world, 'run_completed')[0];
  const output = dataOf(completed)?.output;
  if (output === undefined) return undefined;
  return hydrateWorkflowReturnValue(
    output as Uint8Array,
    completed!.runId,
    undefined,
    []
  );
}

/** Queue calls that are step messages. */
export const stepMessagesOf = (world: AppendOnlyWorld) =>
  world.queueCalls.filter(
    (call) => (call.message as { stepId?: string }).stepId !== undefined
  );

/** Queue calls that are orchestrator messages (wakes and timers). */
export const orchestratorMessagesOf = (world: AppendOnlyWorld) =>
  world.queueCalls.filter(
    (call) => (call.message as { stepId?: string }).stepId === undefined
  );

/**
 * Asserts that a delivery stood down by replacing its message: it returned
 * nothing (acknowledged), and the World holds exactly one fresh orchestrator
 * message that replaces `replaced` (see `replacesMessage`). Returns it.
 */
export function expectReplaced(
  world: AppendOnlyWorld,
  result: unknown,
  replaced: { messageId: string }
): HeldMessage {
  if (result !== undefined) {
    throw new Error(
      `expected the delivery to acknowledge, got ${JSON.stringify(result)}`
    );
  }
  if (world.held.some((h) => h.messageId === replaced.messageId)) {
    throw new Error('expected the replaced message to be acknowledged');
  }
  const replacements = world.held.filter(
    (h) =>
      (h.message as { replacesMessage?: { messageId?: string } })
        .replacesMessage?.messageId === replaced.messageId
  );
  if (replacements.length !== 1) {
    throw new Error(
      `expected one replacement message, found ${replacements.length}`
    );
  }
  return replacements[0]!;
}
