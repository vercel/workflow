// Error: sync function with use step
export function syncStep() {
  'use step';
  return 42;
}

// Error: sync arrow function with use workflow
export const syncWorkflow = () => {
  'use workflow';
  return 'test';
};

// Error: sync method with use step
const obj = {
  syncMethod() {
    'use step';
    return true;
  },
};

// These are ok
export async function validStep() {
  'use step';
  return 42;
}

export const validWorkflow = async () => {
  'use workflow';
  return 'test';
};
