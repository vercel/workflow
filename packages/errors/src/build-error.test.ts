import { describe, expect, test } from 'vitest';
import { WorkflowBuildError, WorkflowError } from './index.js';

describe('WorkflowBuildError', () => {
  test('sets the name and extends WorkflowError', () => {
    const err = new WorkflowBuildError('boom');
    expect(err.name).toBe('WorkflowBuildError');
    expect(err).toBeInstanceOf(WorkflowError);
    expect(err).toBeInstanceOf(WorkflowBuildError);
  });

  test('appends hint with a blank line separator', () => {
    const err = new WorkflowBuildError('Build failed during steps', {
      hint: 'run `pnpm install workflow` and try again',
    });
    expect(err.hint).toBe('run `pnpm install workflow` and try again');
    expect(err.message).toMatchInlineSnapshot(`
      "Build failed during steps
      ╰▶ hint: run \`pnpm install workflow\` and try again"
    `);
  });

  test('preserves cause for debugging', () => {
    const cause = new TypeError('underlying esbuild failure');
    const err = new WorkflowBuildError('boom', { cause });
    expect(err.cause).toBe(cause);
  });

  test('WorkflowBuildError.is discriminates by name', () => {
    const err = new WorkflowBuildError('boom');
    const other = new Error('boom');
    expect(WorkflowBuildError.is(err)).toBe(true);
    expect(WorkflowBuildError.is(other)).toBe(false);
    expect(WorkflowBuildError.is(null)).toBe(false);
  });
});
