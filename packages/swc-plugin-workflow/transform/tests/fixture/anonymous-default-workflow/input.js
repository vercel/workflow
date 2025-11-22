// Test anonymous default export workflow
export default async function() {
  'use workflow';
  const result = await someStep();
  return result;
}

