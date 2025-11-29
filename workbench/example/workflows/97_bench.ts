// Benchmark workflows for performance testing

async function doWork() {
  'use step';
  return 42;
}

// Workflow with no steps - pure orchestration
export async function noStepsWorkflow(input: number) {
  'use workflow';
  return input * 2;
}

// Workflow with 1 step
export async function oneStepWorkflow(input: number) {
  'use workflow';
  const result = await doWork();
  return result + input;
}

// Workflow with 10 sequential steps
export async function tenSequentialStepsWorkflow() {
  'use workflow';
  let result = 0;
  for (let i = 0; i < 10; i++) {
    result = await doWork();
  }
  return result;
}

// Workflow with 10 parallel steps
export async function tenParallelStepsWorkflow() {
  'use workflow';
  const promises = [];
  for (let i = 0; i < 10; i++) {
    promises.push(doWork());
  }
  const results = await Promise.all(promises);
  return results.reduce((sum, val) => sum + val, 0);
}
