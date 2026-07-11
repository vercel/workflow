import type { WorkflowExecutionErrorOccurrence } from '@workflow/world';
import { safeWaitUntil } from './runtime/wait-until.js';
import { getWorldLazy } from './runtime/get-world-lazy.js';
import { contextStorage } from './step/context-storage.js';

export function experimental_reportExecutionErrorOccurrence(
  event: WorkflowExecutionErrorOccurrence
): void {
  const store = contextStorage.getStore();
  const runId = store?.workflowMetadata?.workflowRunId;
  if (!runId) return;

  safeWaitUntil(
    (async () => {
      if (store.runReadyBarrier) {
        try {
          await store.runReadyBarrier;
        } catch {
          // Ordering barrier only. If the run truly does not exist, reporting below
          // fails and is swallowed as best-effort execution-error reporting.
        }
      }
      const world = await getWorldLazy();
      const writer = store.stepMetadata
        ? ({
            type: 'step',
            stepId: store.stepMetadata.stepId,
            attempt: store.stepMetadata.attempt,
          } as const)
        : undefined;
      await world.executionErrors?.reportOccurrence(runId, { event, writer });
    })(),
    () => {
      // Execution-error indexing must never change workflow execution behavior.
    }
  );
}
