import * as workflow from './index.js';
import * as workflowCatalog from './workflow/index.js';
import type {
  ActiveStepAbortController,
  ActiveStepAbortControllerOptions,
} from './workflow/index.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const factorySymbol = Symbol.for(
  'WORKFLOW_CREATE_ACTIVE_STEP_ABORT_CONTROLLER'
);

afterEach(() => {
  delete (globalThis as Record<PropertyKey, unknown>)[factorySymbol];
});

describe('createActiveStepAbortController', () => {
  it('exports the active-step controller and its public types through the workflow catalog', () => {
    expect(workflowCatalog.createActiveStepAbortController).toBeTypeOf(
      'function'
    );

    const options: ActiveStepAbortControllerOptions = {
      token: 'abrt_turn_control',
    };
    const controller: ActiveStepAbortController = {
      dispose() {},
      signal: new AbortController().signal,
      token: options.token,
    };
    expect(controller.token).toBe(options.token);
  });

  it('exposes the workflow-only controller that a driver can resume during an active step', () => {
    expect(workflow).toHaveProperty('createActiveStepAbortController');
  });

  it('delegates a deterministic abort token to the workflow runtime', () => {
    const controller = {
      dispose: vi.fn(),
      signal: new AbortController().signal,
      token: 'abrt_turn_control',
    };
    const factory = vi.fn(() => controller);
    (globalThis as Record<PropertyKey, unknown>)[factorySymbol] = factory;

    expect(
      workflow.createActiveStepAbortController({ token: 'abrt_turn_control' })
    ).toBe(controller);
    expect(factory).toHaveBeenCalledWith({ token: 'abrt_turn_control' });
  });

  it('rejects tokens outside the reserved abort namespace', () => {
    expect(() =>
      workflow.createActiveStepAbortController({ token: 'turn_control' })
    ).toThrow('beginning with "abrt_"');
  });

  it('rejects non-canonical abort tokens before they can alias a stream name', () => {
    expect(() =>
      workflow.createActiveStepAbortController({ token: 'abrt_turn:0' })
    ).toThrow('canonical');
  });
});
