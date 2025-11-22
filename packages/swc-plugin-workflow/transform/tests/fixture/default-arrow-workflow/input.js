// Test default export arrow workflow
export default async (data) => {
  'use workflow';
  const processed = await processData(data);
  return processed;
};

