import type { WorkflowRunStatus } from '@workflow/world';
import { WORKFLOW_CLASS_REGISTRY } from '../symbols.js';
import type { WorkflowOrchestratorContext } from '../private.js';
import { createUseStep } from '../step.js';

/**
 * Creates a WorkflowRun class for use inside the workflow VM.
 * Each method/getter delegates to a registered built-in step so that
 * side effects (world access) happen in the step context, not the VM.
 *
 * Shares the same serialization classId ('Run') as the runtime Run class
 * so that Run instances serialized in step context deserialize as
 * WorkflowRun instances in the workflow VM, and vice versa.
 */
export function createWorkflowRun(ctx: WorkflowOrchestratorContext) {
  const cancelStep = createUseStep(ctx)<[string], void>('__run_cancel');
  const statusStep = createUseStep(ctx)<[string], WorkflowRunStatus>(
    '__run_status'
  );
  const returnValueStep = createUseStep(ctx)<[string], unknown>(
    '__run_return_value'
  );
  const workflowNameStep = createUseStep(ctx)<[string], string>(
    '__run_workflow_name'
  );
  const createdAtStep = createUseStep(ctx)<[string], Date>('__run_created_at');
  const startedAtStep = createUseStep(ctx)<[string], Date | undefined>(
    '__run_started_at'
  );
  const completedAtStep = createUseStep(ctx)<[string], Date | undefined>(
    '__run_completed_at'
  );
  const existsStep = createUseStep(ctx)<[string], boolean>('__run_exists');

  class WorkflowRun<TResult = unknown> {
    /**
     * Marker used by the serialization system to identify WorkflowRun instances.
     * Uses the same value as Run.__serializable so the serializer treats them the same.
     * @internal
     */
    static readonly __serializable = 'Run' as const;

    readonly runId: string;

    constructor(runId: string) {
      this.runId = runId;
    }

    async cancel(): Promise<void> {
      return cancelStep(this.runId);
    }

    get status(): Promise<WorkflowRunStatus> {
      return statusStep(this.runId);
    }

    get returnValue(): Promise<TResult> {
      return returnValueStep(this.runId) as Promise<TResult>;
    }

    get workflowName(): Promise<string> {
      return workflowNameStep(this.runId);
    }

    get createdAt(): Promise<Date> {
      return createdAtStep(this.runId);
    }

    get startedAt(): Promise<Date | undefined> {
      return startedAtStep(this.runId);
    }

    get completedAt(): Promise<Date | undefined> {
      return completedAtStep(this.runId);
    }

    get exists(): Promise<boolean> {
      return existsStep(this.runId);
    }
  }

  // Register in the VM's class registry so the serialization system's
  // Run reviver can find this class and create WorkflowRun instances
  // when deserializing Run objects from step results.
  const vmGlobal = ctx.globalThis as any;
  let registry = vmGlobal[WORKFLOW_CLASS_REGISTRY] as
    | Map<string, Function>
    | undefined;
  if (!registry) {
    registry = new Map();
    vmGlobal[WORKFLOW_CLASS_REGISTRY] = registry;
  }
  registry.set('Run', WorkflowRun);

  return WorkflowRun;
}
