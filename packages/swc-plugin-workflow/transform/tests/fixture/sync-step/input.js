// Sync functions with "use step" are allowed.
// This enables using "use step" as a mechanism to strip Node.js-dependent
// code from the workflow VM bundle.

export function syncStep() {
  'use step';
  return 42;
}

export const syncArrow = () => {
  'use step';
  return 'hello';
};

export const obj = {
  syncMethod() {
    'use step';
    return true;
  },
};

// Async steps still work as before
export async function asyncStep(a, b) {
  'use step';
  return a + b;
}
