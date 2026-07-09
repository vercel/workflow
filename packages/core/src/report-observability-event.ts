import type { WorkflowObservabilityEvent } from '@workflow/world';
import { getWorldLazy } from './runtime/get-world-lazy.js';
import { contextStorage } from './step/context-storage.js';

export async function experimental_reportObservabilityEvent(
  event: WorkflowObservabilityEvent
): Promise<void> {
  const store = contextStorage.getStore();
  const runId = store?.workflowMetadata?.workflowRunId;
  if (!runId) return;

  if (store.runReadyBarrier) {
    try {
      await store.runReadyBarrier;
    } catch {
      // Ordering barrier only. If the run truly does not exist, reporting below
      // fails and is swallowed as best-effort observability.
    }
  }

  try {
    const world = await getWorldLazy();
    await world.observability?.reportEvent(runId, {
      event,
      writer: {
        type: 'step',
        stepId: store.stepMetadata.stepId,
        attempt: store.stepMetadata.attempt,
      },
    });
  } catch {
    // Observability indexing must never change workflow execution behavior.
  }
}
