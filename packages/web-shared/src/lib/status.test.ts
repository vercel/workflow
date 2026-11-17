import { StepStatusSchema, WorkflowRunStatusSchema } from '@workflow/world';
import { describe, expect, it } from 'vitest';
import { STATUS } from './status';

describe('STATUS', () => {
  it('covers every run and step status', () => {
    for (const status of [
      ...WorkflowRunStatusSchema.options,
      ...StepStatusSchema.options,
    ]) {
      expect(STATUS[status]).toBeDefined();
    }
  });

  it.each([
    ['pending', 'bg-gray-700'],
    ['running', 'bg-amber-700'],
    ['completed', 'bg-teal-600'],
    ['failed', 'bg-red-700'],
    ['cancelled', 'bg-gray-700'],
  ] as const)('gives a %s run a themed %s dot', (status, dot) => {
    expect(STATUS[status].dot).toBe(dot);
  });

  it('colours a timeline segment like the matching run status', () => {
    expect(STATUS.succeeded.bar).toBe(STATUS.completed.bar);
    expect(STATUS.retrying.tone).toBe(STATUS.running.tone);
  });

  it('uses no generic green or fixed migration colours', () => {
    const classes = Object.values(STATUS)
      .flatMap((style) => [style.dot, style.bar, style.text])
      .join(' ');
    expect(classes).not.toMatch(/green|geist-/);
  });
});
