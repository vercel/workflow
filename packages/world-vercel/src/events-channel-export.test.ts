import { afterEach, describe, expect, it } from 'vitest';
import { openEventsChannel } from './index.js';

describe('openEventsChannel', () => {
  const previous = process.env.WORKFLOW_EVENTS_TRANSPORT;
  afterEach(() => {
    if (previous === undefined) delete process.env.WORKFLOW_EVENTS_TRANSPORT;
    else process.env.WORKFLOW_EVENTS_TRANSPORT = previous;
    delete process.env.WORKFLOW_EVENTS_TRANSPORT_WS_OVERRIDE_WORKFLOWS;
  });

  it('is exported from the package root', () => {
    expect(typeof openEventsChannel).toBe('function');
  });

  it('returns undefined, so writes stay on HTTP, when the transport is set to http', () => {
    process.env.WORKFLOW_EVENTS_TRANSPORT = 'http';
    expect(
      openEventsChannel('wrun_01ARZ3NDEKTSV4RRFFQ69G5FAV')
    ).toBeUndefined();
  });

  it('returns undefined by default, so writes stay on HTTP', () => {
    delete process.env.WORKFLOW_EVENTS_TRANSPORT;
    expect(
      openEventsChannel('wrun_01ARZ3NDEKTSV4RRFFQ69G5FAV')
    ).toBeUndefined();
  });

  it('returns undefined for a projectConfig World, which cannot hold a socket', () => {
    process.env.WORKFLOW_EVENTS_TRANSPORT = 'ws';
    expect(
      openEventsChannel('wrun_01ARZ3NDEKTSV4RRFFQ69G5FAV', {
        projectConfig: { projectId: 'prj_test', teamId: 'team_test' },
      } as never)
    ).toBeUndefined();
  });

  it('opens nothing for a workflow the override does not list', () => {
    delete process.env.WORKFLOW_EVENTS_TRANSPORT;
    process.env.WORKFLOW_EVENTS_TRANSPORT_WS_OVERRIDE_WORKFLOWS =
      'betaWorkflow';
    expect(
      openEventsChannel('wrun_01ARZ3NDEKTSV4RRFFQ69G5FAV')
    ).toBeUndefined();
    expect(
      openEventsChannel('wrun_01ARZ3NDEKTSV4RRFFQ69G5FAV', undefined, {
        workflowName: 'workflow//./src/workflows/orders//processOrder',
      })
    ).toBeUndefined();
  });
});
