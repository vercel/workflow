async function runIndexedStep(index: number): Promise<{ index: number }> {
  'use step';
  return { index };
}

export async function twoHundredStepsWorkflow() {
  'use workflow';

  const totalSteps = 200;
  const results: number[] = [];

  for (let i = 0; i < totalSteps; i++) {
    const result = await runIndexedStep(i);
    results.push(result.index);
  }

  return {
    totalSteps,
    firstStep: results[0],
    lastStep: results[results.length - 1],
  };
}

// ---------------------------------------------------------------------------
// Reproduction workflow for the scheduleWhenIdle premature-suspension bug.
// ---------------------------------------------------------------------------
//
// Symlinked into multiple workbenches (nextjs-turbopack, nextjs-webpack,
// nitro-v3, sveltekit) even though the e2e currently runs only on
// nextjs-turbopack + Vercel, so widening the test gate later does not require
// re-creating the symlink set.
//
// Generic stress workflow for high-concurrency replay:
//   setup -> validate -> create resource -> Promise.all([
//     metadata task,
//     ...items.map(async () => {
//       parallel phase-one work -> phase-two aggregate -> list items ->
//       per-item verification attempts -> shared marker -> final fan-out
//     })
//   ]) -> finalize
//
// The important shape is a moderately wide outer Promise.all where each item
// advances through several sequential waves while a few search repetitions are
// slow stragglers. Those stragglers schedule WorkflowSuspension while fast items
// are still hydrating results and registering next-wave callbacks.

async function lifecycleMarkerStep(status: string) {
  'use step';
  await new Promise((r) => setTimeout(r, 5));
  return { status };
}

async function validateInputsStep() {
  'use step';
  return { dimensions: ['alpha', 'beta'] };
}

async function createResourceStep() {
  'use step';
  await new Promise((r) => setTimeout(r, 10));
  return { resourceId: 'resource_schedule_when_idle_stress' };
}

async function metadataStep(resourceId: string) {
  'use step';
  await new Promise((r) => setTimeout(r, 30));
  return { resourceId, name: 'Schedule When Idle Stress' };
}

async function phaseWorkStep(
  phase: 'phase-one' | 'phase-two' | 'verify',
  item: number,
  variant = 0
) {
  'use step';

  if (phase === 'phase-one') {
    const isStraggler = item % 5 === 3 && variant === 0;
    const delay = isStraggler
      ? 2000 + ((item * 31) % 1000)
      : 30 + ((item * 11 + variant * 7) % 80);
    await new Promise((r) => setTimeout(r, delay));
    return {
      phase,
      item,
      values: [`phase_one_${item}_${variant}`],
    };
  }

  const delay =
    phase === 'phase-two'
      ? 30 + ((item * 7) % 50)
      : 15 + ((item * 5 + variant * 3) % 30);
  await new Promise((r) => setTimeout(r, delay));
  return { phase, item, values: [`${phase}_${item}_${variant}`] };
}

async function listRelatedItemsStep(item: number) {
  'use step';
  await new Promise((r) => setTimeout(r, 20 + ((item * 13) % 40)));
  return { item, results: [`r_${item}_a`, `r_${item}_b`] };
}

async function verifyRelatedItemStep(item: number, resultIndex: number) {
  'use step';
  await new Promise((r) => setTimeout(r, 5 + ((item + resultIndex) % 10)));
  return true;
}

async function sharedMarkerStep() {
  'use step';
  await new Promise((r) => setTimeout(r, 5));
  return '2026-05-07';
}

async function finalUpdateStep(item: number, resultId: string) {
  'use step';
  await new Promise((r) => setTimeout(r, 5 + ((item * 2) % 15)));
  return { item, resultId, updated: true };
}

async function finalReadStep(item: number, resultId: string) {
  'use step';
  await new Promise((r) => setTimeout(r, 10 + ((item * 3) % 20)));
  return { item, resultId, status: 'active' };
}

async function verifyWithRetries(item: number, resultIndex: number) {
  const maxAttempts = 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await phaseWorkStep('verify', item, resultIndex);
    const verified = await verifyRelatedItemStep(item, resultIndex);
    if (verified) {
      return;
    }
  }
}

export async function concurrentMultiWaveWorkflow() {
  'use workflow';

  await lifecycleMarkerStep('started');
  await validateInputsStep();
  const { resourceId } = await createResourceStep();

  const metadata = metadataStep(resourceId);

  const N_ITEMS = 12;
  const REPS_PER_ITEM = 2;

  await Promise.all([
    metadata,
    ...Array.from({ length: N_ITEMS }, async (_, i) => {
      const repetitionOutcomes = await Promise.allSettled(
        Array.from({ length: REPS_PER_ITEM }, (_, rep) =>
          phaseWorkStep('phase-one', i, rep)
        )
      );
      const values = repetitionOutcomes.flatMap((outcome) =>
        outcome.status === 'fulfilled' ? outcome.value.values : []
      );

      await phaseWorkStep('phase-two', i, values.length);

      const relatedItems = await listRelatedItemsStep(i);

      await Promise.allSettled(
        relatedItems.results.map((_, resultIndex) =>
          verifyWithRetries(i, resultIndex)
        )
      );

      const marker = await sharedMarkerStep();
      await Promise.allSettled(
        relatedItems.results.map(async (resultId) => {
          await finalReadStep(i, resultId);
          await finalUpdateStep(i, resultId);
        })
      );

      return { item: i, marker, ok: true };
    }),
  ]);

  await lifecycleMarkerStep('completed');

  return { totalItems: N_ITEMS, completed: N_ITEMS };
}
