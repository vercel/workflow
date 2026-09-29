import { afterEach, describe, expect, it } from 'vitest';
import { openEventsChannel } from './index.js';

describe('openEventsChannel', () => {
  const previous = process.env.WORKFLOW_EVENTS_TRANSPORT;
  afterEach(() => {
    if (previous === undefined) delete process.env.WORKFLOW_EVENTS_TRANSPORT;
    else process.env.WORKFLOW_EVENTS_TRANSPORT = previous;
  });

  it('is exported from the package root', () => {
    expect(typeof openEventsChannel).toBe('function');
  });

  it('returns undefined, so writes stay on HTTP, when the transport is disabled', () => {
    process.env.WORKFLOW_EVENTS_TRANSPORT = 'http';
    expect(
      openEventsChannel('wrun_01ARZ3NDEKTSV4RRFFQ69G5FAV')
    ).toBeUndefined();
  });

  it('returns undefined for a projectConfig World, which cannot hold a socket', () => {
    delete process.env.WORKFLOW_EVENTS_TRANSPORT;
    expect(
      openEventsChannel('wrun_01ARZ3NDEKTSV4RRFFQ69G5FAV', {
        projectConfig: { projectId: 'prj_test', teamId: 'team_test' },
      } as never)
    ).toBeUndefined();
  });
});
