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
