import type { WorkflowObservabilityEvent } from '@workflow/world';
import { safeWaitUntil } from './runtime/wait-until.js';
import { getWorldLazy } from './runtime/get-world-lazy.js';
import { contextStorage } from './step/context-storage.js';

export function experimental_reportObservabilityEvent(
  event: WorkflowObservabilityEvent
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
          // fails and is swallowed as best-effort observability.
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
      await world.observability?.reportEvent(runId, { event, writer });
    })(),
    () => {
      // Observability indexing must never change workflow execution behavior.
    }
  );
}
