import { createHook, getWorkflowMetadata, sleep } from 'workflow';

interface ReproInput {
  token: string;
  iterations?: number;
  sleepMs?: number;
  returnOnWake?: boolean;
  finalDelayMs?: number;
  drainDelayMs?: number;
  sleepBranchWaitCount?: number;
  sleepBranchWaitMs?: number;
  sleepBranchWaitSpacingMs?: number;
}

interface WakePayload {
  attempt: number;
  sentAt: number;
}

interface RaceBranchRecord {
  branch: 'sleep' | 'wake';
  iteration: number;
  drained?: unknown;
  event?: IteratorResult<WakePayload>;
}

type RaceBranch =
  | { kind: 'sleep' }
  | { kind: 'hook'; event: IteratorResult<WakePayload> };

async function syncStep(input: { runId: string; iteration: number }) {
  'use step';
  return { ...input, syncedAt: Date.now() };
}

async function drainStep(input: {
  delayMs: number;
  runId: string;
  iteration: number;
}) {
  'use step';
  if (input.delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, input.delayMs));
  }
  return { ...input, drainedAt: Date.now() };
}

async function finalStep(input: { delayMs: number; runId: string }) {
  'use step';
  if (input.delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, input.delayMs));
  }
  return { ...input, finishedAt: Date.now() };
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep this close to the shared repro shape.
export async function hookSleepReproWorkflow(input: ReproInput) {
  'use workflow';

  const metadata = getWorkflowMetadata();
  const hook = createHook<WakePayload>({ token: input.token });
  const iterator = hook[Symbol.asyncIterator]();

  const iterations = input.iterations ?? 2;
  const sleepMs = input.sleepMs ?? 5000;
  const returnOnWake = input.returnOnWake ?? false;
  const finalDelayMs = input.finalDelayMs ?? 0;
  const sleepBranchWaitCount = input.sleepBranchWaitCount ?? 0;
  const sleepBranchWaitMs = input.sleepBranchWaitMs ?? sleepMs;
  const sleepBranchWaitSpacingMs = input.sleepBranchWaitSpacingMs ?? 0;

  const branches: RaceBranchRecord[] = [];
  let pendingHookRead: Promise<IteratorResult<WakePayload>> | undefined;

  try {
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      await syncStep({ runId: metadata.workflowRunId, iteration });

      pendingHookRead ??= iterator.next();

      const result = await Promise.race<RaceBranch>([
        pendingHookRead.then((event) => ({ kind: 'hook' as const, event })),
        sleep(sleepMs).then(() => ({ kind: 'sleep' as const })),
      ]);

      if (result.kind === 'sleep') {
        branches.push({ branch: 'sleep', iteration });

        if (sleepBranchWaitCount > 0) {
          const waits = [];
          for (let index = 0; index < sleepBranchWaitCount; index += 1) {
            waits.push(
              sleep(sleepBranchWaitMs + index * sleepBranchWaitSpacingMs)
            );
          }
          await Promise.all(waits);
        }

        continue;
      }

      pendingHookRead = undefined;

      const drained = await drainStep({
        delayMs: input.drainDelayMs ?? 0,
        runId: metadata.workflowRunId,
        iteration,
      });

      branches.push({
        branch: 'wake',
        drained,
        event: result.event,
        iteration,
      });

      if (returnOnWake) {
        if (finalDelayMs > 0) {
          await finalStep({
            delayMs: finalDelayMs,
            runId: metadata.workflowRunId,
          });
        }

        return { branches, runId: metadata.workflowRunId, sleepMs };
      }
    }

    if (finalDelayMs > 0) {
      await finalStep({ delayMs: finalDelayMs, runId: metadata.workflowRunId });
    }

    return { branches, runId: metadata.workflowRunId, sleepMs };
  } finally {
    hook.dispose();
  }
}
