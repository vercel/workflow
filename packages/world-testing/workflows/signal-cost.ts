// Repro for vercel/workflow#2795 / #2797: threading an AbortSignal into a step
// adds fixed per-step latency on world-local (and degrades further as the
// world accumulates stream chunks). This workflow runs N trivial steps, with
// the signal optionally omitted from the step input.

async function trivialStep(input: {
  index: number;
  abortSignal?: AbortSignal;
}): Promise<number> {
  'use step';
  return input.index;
}

export async function signalCostWorkflow(input: {
  count: number;
  withSignal: boolean;
}): Promise<string> {
  'use workflow';
  const controller = new AbortController();
  for (let index = 0; index < input.count; index++) {
    await trivialStep({
      abortSignal: input.withSignal ? controller.signal : undefined,
      index,
    });
  }
  return 'done';
}
