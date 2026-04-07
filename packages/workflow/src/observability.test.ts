import { describe, expect, test } from 'vitest';
import {
  hydrateData,
  hydrateResourceIO,
  observabilityRevivers,
  parseClassName,
  parseStepName,
  parseWorkflowName,
} from './observability';

describe('workflow/observability re-exports', () => {
  test('parseStepName is exported and works', () => {
    const result = parseStepName('step//./src/workflows/pulse//queryKBStep');
    expect(result?.shortName).toBe('queryKBStep');
  });

  test('parseWorkflowName is exported and works', () => {
    const result = parseWorkflowName(
      'workflow//./src/workflows/pulse//pulseRemoteWorkflow'
    );
    expect(result?.shortName).toBe('pulseRemoteWorkflow');
  });

  test('parseClassName is exported and works', () => {
    const result = parseClassName('class//./src/models//MyModel');
    expect(result?.shortName).toBe('MyModel');
  });

  test('observabilityRevivers is exported', () => {
    expect(typeof observabilityRevivers).toBe('object');
    expect(observabilityRevivers).toHaveProperty('ReadableStream');
    expect(observabilityRevivers).toHaveProperty('WritableStream');
    expect(observabilityRevivers).toHaveProperty('StepFunction');
  });

  test('hydrateResourceIO is exported and handles plain values', () => {
    const step = { stepId: 'test', input: 'hello', output: 42 };
    const result = hydrateResourceIO(step, observabilityRevivers);
    expect(result.input).toBe('hello');
    expect(result.output).toBe(42);
  });

  test('hydrateData is exported and passes through plain values', () => {
    expect(hydrateData('hello', observabilityRevivers)).toBe('hello');
    expect(hydrateData(42, observabilityRevivers)).toBe(42);
    expect(hydrateData(null, observabilityRevivers)).toBe(null);
  });
});
