// User explicitly names their workflow function __default
// The workflow ID should use "__default", not normalize to "default"
export async function __default() {
  'use workflow';
  const result = await someStep();
  return result;
}

