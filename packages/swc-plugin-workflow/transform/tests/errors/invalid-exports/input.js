'use step';

// These should all error - not functions
export const value = 42;
export class MyClass {
  method() {}
}
export * from './other';
export let uninitVar;

// Local named exports also error (can't verify binding is a function)
const helper = 'not a function';
export { helper };

// Re-export with specifiers also errors
export { something } from './re-export';

// These are ok - sync and async functions are allowed in "use step" files
export function syncFunc() {
  return 'allowed';
}

export async function validStep() {
  return 'allowed';
}

export const arrowStep = () => 'allowed';
export const asyncArrow = async () => 'allowed';
