// Error: sync arrow function with use workflow (workflow functions must be async)
export const syncWorkflow = () => {
  'use workflow';
  return 'test';
};

// This is ok
export const validWorkflow = async () => {
  'use workflow';
  return 'test';
};
