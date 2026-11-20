import { describe, expect, test } from 'vitest';
import {
  DynamicWorkflowsNotEnabledError,
  FatalError,
  WorkflowError,
  WorkflowRuntimeError,
} from './index.js';

describe('DynamicWorkflowsNotEnabledError', () => {
  test('sets the name and is a WorkflowError, not a WorkflowRuntimeError', () => {
    const err = new DynamicWorkflowsNotEnabledError('refused');
    expect(err.name).toBe('DynamicWorkflowsNotEnabledError');
    expect(err).toBeInstanceOf(WorkflowError);
    expect(err).not.toBeInstanceOf(WorkflowRuntimeError);
    expect(WorkflowRuntimeError.is(err)).toBe(false);
    expect(DynamicWorkflowsNotEnabledError.is(err)).toBe(true);
  });

  test('is fatal, so a step that calls start() does not retry it', () => {
    expect(FatalError.is(new DynamicWorkflowsNotEnabledError('refused'))).toBe(
      true
    );
  });

  test('appends how to opt in and a docs link to the message', () => {
    const err = new DynamicWorkflowsNotEnabledError(
      'Dynamic workflows are not enabled for this project.'
    );
    expect(err.message).toBe(
      [
        'Dynamic workflows are not enabled for this project.',
        '├▶ hint: Set the WORKFLOW_EXPERIMENTAL_DYNAMIC_WORKFLOWS=1 environment variable on your project, then redeploy (or restart your dev server) so the new value takes effect.',
        '╰▶ docs: https://workflow-sdk.dev/docs/advanced/dynamic-workflows#enabling-dynamic-workflows',
      ].join('\n')
    );
  });

  test('is recognized by name across realms (a plain Error with the name)', () => {
    // What a step's thrown error revives as in the workflow VM: the base
    // Error reviver keeps `name`, not the class.
    const revived = Object.assign(new Error('refused'), {
      name: 'DynamicWorkflowsNotEnabledError',
    });
    expect(DynamicWorkflowsNotEnabledError.is(revived)).toBe(true);
    expect(WorkflowRuntimeError.is(revived)).toBe(false);
  });

  test('preserves cause', () => {
    const cause = new Error('underlying');
    expect(
      new DynamicWorkflowsNotEnabledError('refused', { cause }).cause
    ).toBe(cause);
  });
});
