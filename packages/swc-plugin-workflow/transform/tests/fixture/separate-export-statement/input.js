async function stepFunction(a, b) {
  'use step';
  return a + b;
}

async function workflowFunction(a, b) {
  'use workflow';
  const result = await stepFunction(a, b);
  return result * 2;
}

async function normalFunction(a, b) {
  return a * b;
}

export { workflowFunction, stepFunction, normalFunction };

