import { MockAgent } from 'undici';
import { describe, expect, it } from 'vitest';
import { createGetBackendCapabilities } from './backend-capabilities.js';
import { WORKFLOW_SERVER_URL_OVERRIDE } from './utils.js';

const ORIGIN = WORKFLOW_SERVER_URL_OVERRIDE || 'https://vercel-workflow.com';
const PATH = '/api/v2/capabilities';

function agentReplying(status: number, body?: unknown) {
  const agent = new MockAgent();
  agent.disableNetConnect();
  agent
    .get(ORIGIN)
    .intercept({ path: PATH, method: 'GET' })
    .reply(status, body ?? '')
    .persist();
  return agent;
}

describe('createGetBackendCapabilities', () => {
  it('returns the advertised capabilities', async () => {
    const agent = agentReplying(200, { dynamicWorkflowStorageVersion: 1 });
    const getCapabilities = createGetBackendCapabilities({
      token: 'test-token',
      dispatcher: agent,
    });

    await expect(getCapabilities()).resolves.toEqual({
      dynamicWorkflowStorageVersion: 1,
    });
  });

  it('maps a 404 from a backend without the route to an empty set', async () => {
    const agent = agentReplying(404, { error: 'Not Found' });
    const getCapabilities = createGetBackendCapabilities({
      token: 'test-token',
      dispatcher: agent,
    });

    await expect(getCapabilities()).resolves.toEqual({});
  });

  it('propagates a server error rather than reading it as no capabilities', async () => {
    const agent = agentReplying(503, { error: 'Service Unavailable' });
    const getCapabilities = createGetBackendCapabilities({
      token: 'test-token',
      dispatcher: agent,
    });

    await expect(getCapabilities()).rejects.toMatchObject({
      name: 'WorkflowWorldError',
      status: 503,
    });
  });
});
