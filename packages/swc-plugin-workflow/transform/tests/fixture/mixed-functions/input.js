export async function stepFunction(a, b) {
  'use step';
  return a + b;
}

export async function workflowFunction(a, b) {
  'use workflow';
  return stepFunction(a, b);
}

export async function normalFunction(a, b) {
  return a * b;
}
