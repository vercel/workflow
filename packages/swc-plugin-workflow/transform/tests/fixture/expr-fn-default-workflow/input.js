export default async function() {
  'use workflow';
  const result = await someStep();
  return result;
}
