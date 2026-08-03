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

interface GatePayload {
  attempt: number;
  scenario: string;
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

interface StepFanoutInput {
  token: string;
  rounds?: number;
  width?: number;
  stepDelayMs?: number;
  stepDelayJitterMs?: number;
  aggregateDelayMs?: number;
  betweenRoundSleepMs?: number;
}

interface FanoutStepResult {
  runId: string;
  round: number;
  index: number;
  completedAt: number;
}

interface FanoutRoundRecord {
  runId: string;
  round: number;
  count: number;
  checksum: string;
  completedAt: number;
}

interface StepSleepRaceInput {
  token: string;
  rounds?: number;
  stepDelayMs?: number;
  sleepMs?: number;
  postRaceSleepMs?: number;
}

type StepSleepRaceBranch =
  | { kind: 'sleep' }
  | { kind: 'step'; value: StepRaceResult };

interface StepRaceResult {
  runId: string;
  round: number;
  completedAt: number;
}

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

async function fanoutStep(input: {
  delayMs: number;
  runId: string;
  round: number;
  index: number;
}): Promise<FanoutStepResult> {
  'use step';
  if (input.delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, input.delayMs));
  }
  return {
    runId: input.runId,
    round: input.round,
    index: input.index,
    completedAt: Date.now(),
  };
}

async function aggregateFanoutStep(input: {
  delayMs: number;
  runId: string;
  round: number;
  values: FanoutStepResult[];
}): Promise<FanoutRoundRecord> {
  'use step';
  if (input.delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, input.delayMs));
  }
  return {
    runId: input.runId,
    round: input.round,
    count: input.values.length,
    checksum: input.values
      .map((value) => `${value.round}:${value.index}`)
      .join(','),
    completedAt: Date.now(),
  };
}

async function racedStep(input: {
  delayMs: number;
  runId: string;
  round: number;
}): Promise<StepRaceResult> {
  'use step';
  if (input.delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, input.delayMs));
  }
  return {
    runId: input.runId,
    round: input.round,
    completedAt: Date.now(),
  };
}

async function stepBranchMarkerStep(input: { runId: string; round: number }) {
  'use step';
  return { ...input, branch: 'step' as const, markedAt: Date.now() };
}

async function sleepBranchMarkerStep(input: { runId: string; round: number }) {
  'use step';
  return { ...input, branch: 'sleep' as const, markedAt: Date.now() };
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

export async function stepFanoutReplayReproWorkflow(input: StepFanoutInput) {
  'use workflow';

  const metadata = getWorkflowMetadata();
  const hook = createHook<GatePayload>({ token: input.token });
  const iterator = hook[Symbol.asyncIterator]();

  const rounds = input.rounds ?? 4;
  const width = input.width ?? 4;
  const stepDelayMs = input.stepDelayMs ?? 0;
  const stepDelayJitterMs = input.stepDelayJitterMs ?? 50;
  const aggregateDelayMs = input.aggregateDelayMs ?? 0;
  const betweenRoundSleepMs = input.betweenRoundSleepMs ?? 0;
  const roundRecords: FanoutRoundRecord[] = [];

  try {
    await iterator.next();

    for (let round = 0; round < rounds; round += 1) {
      const values = await Promise.all(
        Array.from({ length: width }, (_, index) =>
          fanoutStep({
            delayMs: stepDelayMs + ((round + index) % 2) * stepDelayJitterMs,
            index,
            round,
            runId: metadata.workflowRunId,
          })
        )
      );

      roundRecords.push(
        await aggregateFanoutStep({
          delayMs: aggregateDelayMs,
          round,
          runId: metadata.workflowRunId,
          values,
        })
      );

      if (betweenRoundSleepMs > 0) {
        await sleep(betweenRoundSleepMs);
      }
    }

    return {
      runId: metadata.workflowRunId,
      roundRecords,
      rounds,
      width,
    };
  } finally {
    hook.dispose();
  }
}

export async function stepSleepRaceReproWorkflow(input: StepSleepRaceInput) {
  'use workflow';

  const metadata = getWorkflowMetadata();
  const hook = createHook<GatePayload>({ token: input.token });
  const iterator = hook[Symbol.asyncIterator]();

  const rounds = input.rounds ?? 4;
  const stepDelayMs = input.stepDelayMs ?? 0;
  const sleepMs = input.sleepMs ?? 1000;
  const postRaceSleepMs = input.postRaceSleepMs ?? 0;
  const branches: Array<{
    branch: 'sleep' | 'step';
    marker: unknown;
    round: number;
    value?: StepRaceResult;
  }> = [];

  try {
    await iterator.next();

    for (let round = 0; round < rounds; round += 1) {
      const result = await Promise.race<StepSleepRaceBranch>([
        racedStep({
          delayMs: stepDelayMs,
          round,
          runId: metadata.workflowRunId,
        }).then((value) => ({ kind: 'step' as const, value })),
        sleep(sleepMs).then(() => ({ kind: 'sleep' as const })),
      ]);

      const marker =
        result.kind === 'step'
          ? await stepBranchMarkerStep({
              round,
              runId: metadata.workflowRunId,
            })
          : await sleepBranchMarkerStep({
              round,
              runId: metadata.workflowRunId,
            });

      branches.push({
        branch: result.kind,
        marker,
        round,
        value: result.kind === 'step' ? result.value : undefined,
      });

      if (postRaceSleepMs > 0) {
        await sleep(postRaceSleepMs);
      }
    }

    return {
      branches,
      runId: metadata.workflowRunId,
      rounds,
      sleepMs,
      stepDelayMs,
    };
  } finally {
    hook.dispose();
  }
}
