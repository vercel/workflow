import { afterEach, describe, expect, it } from 'vitest';
import {
  isWsEventsTransportEnabledForWorkflow,
  isWsEventsTransportPossible,
  wsEventsTransportOverrideWorkflows,
} from './ws-transport-enabled.js';

const WORKFLOW = 'workflow//./src/workflows/beta//betaWorkflow';
const OTHER = 'workflow//./src/workflows/orders//processOrder';

afterEach(() => {
  delete process.env.WORKFLOW_EVENTS_TRANSPORT;
  delete process.env.WORKFLOW_EVENTS_TRANSPORT_WS_OVERRIDE_WORKFLOWS;
});

describe('WORKFLOW_EVENTS_TRANSPORT_WS_OVERRIDE_WORKFLOWS', () => {
  it('parses comma-separated tokens, ignoring blanks and whitespace', () => {
    process.env.WORKFLOW_EVENTS_TRANSPORT_WS_OVERRIDE_WORKFLOWS =
      ' betaWorkflow , ,other ';
    expect(wsEventsTransportOverrideWorkflows()).toEqual([
      'betaWorkflow',
      'other',
    ]);
  });

  it('is empty when unset', () => {
    expect(wsEventsTransportOverrideWorkflows()).toEqual([]);
    // WS is the default, so a deployment that sets nothing can still use it.
    expect(isWsEventsTransportPossible()).toBe(true);
    process.env.WORKFLOW_EVENTS_TRANSPORT = 'http';
    expect(isWsEventsTransportPossible()).toBe(false);
  });

  it('moves a listed workflow onto WS while the deployment stays on HTTP', () => {
    process.env.WORKFLOW_EVENTS_TRANSPORT = 'http';
    process.env.WORKFLOW_EVENTS_TRANSPORT_WS_OVERRIDE_WORKFLOWS =
      'betaWorkflow';

    expect(isWsEventsTransportPossible()).toBe(true);
    expect(isWsEventsTransportEnabledForWorkflow(WORKFLOW)).toBe(true);
    expect(isWsEventsTransportEnabledForWorkflow(OTHER)).toBe(false);
    expect(isWsEventsTransportEnabledForWorkflow(undefined)).toBe(false);
  });

  it('matches the function name or the full workflow name, exactly', () => {
    process.env.WORKFLOW_EVENTS_TRANSPORT = 'http';
    process.env.WORKFLOW_EVENTS_TRANSPORT_WS_OVERRIDE_WORKFLOWS = WORKFLOW;
    expect(isWsEventsTransportEnabledForWorkflow(WORKFLOW)).toBe(true);

    for (const token of ['betaworkflow', 'beta', 'betaWorkflow2']) {
      process.env.WORKFLOW_EVENTS_TRANSPORT_WS_OVERRIDE_WORKFLOWS = token;
      expect(isWsEventsTransportEnabledForWorkflow(WORKFLOW)).toBe(false);
    }
  });

  it('adds nothing when the deployment is already on WS', () => {
    for (const value of ['ws', undefined]) {
      if (value === undefined) delete process.env.WORKFLOW_EVENTS_TRANSPORT;
      else process.env.WORKFLOW_EVENTS_TRANSPORT = value;
      expect(isWsEventsTransportEnabledForWorkflow(OTHER)).toBe(true);
      expect(isWsEventsTransportEnabledForWorkflow(undefined)).toBe(true);
    }
  });
});
