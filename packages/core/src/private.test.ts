import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  loadStepFunction,
  registerStepFunction,
  registerStepFunctionLoader,
} from './private.js';

describe('lazy step function loaders', () => {
  it('loads and returns a step function registered by a loader', async () => {
    const stepId = `step//./workflows/lazy-${randomUUID()}//resize`;
    const stepFn = async () => 'loaded';
    let loadCount = 0;

    registerStepFunctionLoader(stepId, () => {
      loadCount++;
      registerStepFunction(stepId, stepFn);
    });

    await expect(loadStepFunction(stepId)).resolves.toBe(stepFn);
    await expect(loadStepFunction(stepId)).resolves.toBe(stepFn);
    expect(loadCount).toBe(2);
  });

  it('lets a loader refresh an already registered step function', async () => {
    const stepId = `step//./workflows/lazy-${randomUUID()}//resize`;
    const firstStepFn = async () => 'first';
    const secondStepFn = async () => 'second';
    let loadCount = 0;

    registerStepFunctionLoader(stepId, () => {
      loadCount++;
      registerStepFunction(
        stepId,
        loadCount === 1 ? firstStepFn : secondStepFn
      );
    });

    await expect(loadStepFunction(stepId)).resolves.toBe(firstStepFn);
    await expect(loadStepFunction(stepId)).resolves.toBe(secondStepFn);
    expect(loadCount).toBe(2);
  });
});
