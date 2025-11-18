export async function stepFunction(a, b) {
  'use step';
  return a + b;
}

async function stepFunctionWithoutExport(a, b) {
  'use step';
  return a - b;
}

export async function workflowFunction(a, b) {
  'use workflow';
  const result = await stepFunction(a, b);
  const result2 = await stepFunctionWithoutExport(a, b);
  return result + result2;
}

export async function normalFunction(a, b) {
  return a * b;
}
