// Test workflow functions in client mode

export async function myWorkflow() {
  'use workflow';
  const result = await someStep();
  return result;
}

export const arrowWorkflow = async () => {
  'use workflow';
  const data = await fetchData();
  return data;
};

export default async function defaultWorkflow() {
  'use workflow';
  return await process();
}

// Non-export workflow function
async function internalWorkflow() {
  'use workflow';
  return 'internal';
}

// Use the internal workflow to avoid lint warning
regularFunction(internalWorkflow);

// Regular function should not be affected
export function regularFunction() {
  return 'regular';
}