// Step error test helpers - functions that execute in the step (Node.js) context
// These demonstrate stack trace preservation for errors thrown in step execution

import { FatalError } from 'workflow';

export function throwStepError() {
  throw new FatalError('Error from step helper');
}

export function stepErrorHelper() {
  throwStepError();
}

export async function deepStepWithNestedError() {
  'use step';
  stepErrorHelper();
  return 'never reached';
}
