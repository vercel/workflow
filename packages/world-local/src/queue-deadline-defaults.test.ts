import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { NODE_HTTP_ENV_VAR } from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Record what each transport is actually built with, so the test pins the
// wiring (#3909) rather than only the value `getQueueAgentOptions()` returns.
const agentOptions = vi.hoisted(() => [] as Record<string, unknown>[]);
const fetchOptions = vi.hoisted(() => [] as Record<string, unknown>[]);

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  class RecordingAgent extends actual.Agent {
    constructor(options: ConstructorParameters<typeof actual.Agent>[0]) {
      agentOptions.push({ ...options });
      super(options);
    }
  }
  return { ...actual, Agent: RecordingAgent };
});

vi.mock('@workflow/world/node-http.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@workflow/world/node-http.js')>();
  return {
    ...actual,
    nodeHttpFetch: (url: string, init: Record<string, unknown>) => {
      fetchOptions.push({
        headersTimeoutMs: init.headersTimeoutMs,
        bodyTimeoutMs: init.bodyTimeoutMs,
      });
      return actual.nodeHttpFetch(url, init as never);
    },
  };
});

const { createQueue, getQueueAgentOptions } = await import('./queue.js');

const payload = { runId: 'run_01ABC', stepId: 'step_01ABC', stepName: 's' };

/**
 * The deadlines an operator gets by setting both overrides to `0`, the
 * documented value that disables them. The defaults must match this.
 */
function disabledDeadlines(): { headersTimeout: number; bodyTimeout: number } {
  vi.stubEnv('WORKFLOW_LOCAL_HEADERS_TIMEOUT_MS', '0');
  vi.stubEnv('WORKFLOW_LOCAL_BODY_TIMEOUT_MS', '0');
  const { headersTimeout, bodyTimeout } = getQueueAgentOptions();
  vi.stubEnv('WORKFLOW_LOCAL_HEADERS_TIMEOUT_MS', '');
  vi.stubEnv('WORKFLOW_LOCAL_BODY_TIMEOUT_MS', '');
  return { headersTimeout, bodyTimeout };
}

describe('queue delivery deadlines are off by default (#3909)', () => {
  let server: Server | undefined;

  afterEach(async () => {
    agentOptions.length = 0;
    fetchOptions.length = 0;
    vi.unstubAllEnvs();
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server?.close(resolve));
      server = undefined;
    }
  });

  it('builds the undici Agent with no headers/body deadline', async () => {
    const disabled = disabledDeadlines();
    vi.stubEnv(NODE_HTTP_ENV_VAR, '0');
    const queue = createQueue({ baseUrl: 'http://127.0.0.1:1' });
    await queue.close();
    expect(agentOptions).toHaveLength(1);
    expect(agentOptions[0]).toMatchObject(disabled);
  });

  it('passes no headers/body deadline to node:http deliveries', async () => {
    const disabled = disabledDeadlines();
    vi.stubEnv(NODE_HTTP_ENV_VAR, '1');
    server = createServer((request, response) => {
      request.resume();
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => {
      server?.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address() as AddressInfo;
    const queue = createQueue({ baseUrl: `http://127.0.0.1:${port}` });
    try {
      await queue.queue('__wkf_workflow_test' as any, payload);
      await vi.waitFor(() => expect(fetchOptions).toHaveLength(1));
      expect(fetchOptions[0]).toEqual({
        headersTimeoutMs: disabled.headersTimeout,
        bodyTimeoutMs: disabled.bodyTimeout,
      });
      expect(agentOptions).toHaveLength(0);
    } finally {
      await queue.close();
    }
  });
});
