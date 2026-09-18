import { channel } from 'node:diagnostics_channel';
import { createServer } from 'node:http';
import { EntityConflictError } from '@workflow/errors';
import { unwrapInvocationOutcome } from '@workflow/errors/invocation';
import { decode, encode } from 'cbor-x';
import { generateKeyPair, SignJWT } from 'jose';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  AFFINITY_HEADER,
  createDirectInvocationHandler,
  createInvoker,
  DEPLOYMENT_HEADER,
  INVOCATION_HEADER,
  invocationAffinity,
} from './invocation.js';
import { createQueue } from './queue.js';

const mocks = vi.hoisted(() => ({
  key: undefined as unknown,
  token: '',
  run: vi.fn(),
  retain: vi.fn(),
  send: vi.fn().mockResolvedValue({ messageId: 'message' }),
  vqsRequest: vi.fn(),
  inject: vi.fn(async (headers: Headers) =>
    headers.set(
      'traceparent',
      '00-11111111111111111111111111111111-2222222222222222-01'
    )
  ),
}));
vi.mock('jose', async (original) => ({
  ...(await original<typeof import('jose')>()),
  createRemoteJWKSet: () => async () => mocks.key,
}));
vi.mock('@vercel/oidc', () => ({
  getVercelOidcToken: async () => mocks.token,
}));
vi.mock('@vercel/functions', () => ({
  waitUntil: (work: Promise<unknown>) => mocks.retain(work),
}));
vi.mock('./runs.js', () => ({
  getWorkflowRun: (...args: unknown[]) => mocks.run(...args),
}));
vi.mock('./telemetry.js', async (original) => ({
  ...(await original<typeof import('./telemetry.js')>()),
  injectTraceContextIntoHeaders: mocks.inject,
}));
vi.mock('@vercel/queue', () => ({
  ConsumerDiscoveryError: class ConsumerDiscoveryError extends Error {},
  QueueClient: class {
    send = mocks.send;
    handleCallback(
      callback: (message: unknown, metadata: unknown) => Promise<unknown>
    ) {
      return async (req: Request) => {
        mocks.vqsRequest();
        await callback(decode(Buffer.from(await req.arrayBuffer())), {
          messageId: 'queue-message',
          deliveryCount: 1,
        });
        return new Response(null, { status: 200 });
      };
    }
  },
}));

const runId = 'wrun_01K4JQM0NR0000000000000000';
const endpoint = 'https://workflow.example.test/.well-known/workflow/v1/invoke';
const config = { invoke: { endpoint } };
const payload = { type: 'hook_resume', payload: new Uint8Array([1, 2, 3]) };
let sign: (claims?: Record<string, unknown>) => Promise<string>;

function request(
  input = payload,
  overrides: Record<string, unknown> = {},
  headers: Record<string, string> = {}
) {
  return new Request(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/cbor',
      authorization: `Bearer ${mocks.token}`,
      [INVOCATION_HEADER]: '1',
      [AFFINITY_HEADER]: invocationAffinity(runId),
      [DEPLOYMENT_HEADER]: 'dpl_pinned',
      ...headers,
    },
    body: encode({
      version: 1,
      runId,
      requestId: 'request',
      input,
      deploymentId: 'dpl_pinned',
      queueName: '__wkf_workflow_example',
      timeoutMs: 30000,
      ...overrides,
    }),
  });
}

beforeAll(async () => {
  const keys = await generateKeyPair('RS256');
  mocks.key = keys.publicKey;
  sign = (claims = {}) =>
    new SignJWT({
      project_id: 'prj_test',
      environment: 'production',
      ...claims,
    })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer('https://oidc.vercel.com/team_test')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(keys.privateKey);
  mocks.token = await sign();
});
beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.stubEnv('VERCEL_PROJECT_ID', 'prj_test');
  vi.stubEnv('VERCEL_ENV', 'production');
  vi.stubEnv('VERCEL_TARGET_ENV', 'production');
  vi.stubEnv('VERCEL_DEPLOYMENT_ID', 'dpl_pinned');
  vi.stubEnv('VERCEL_REGION', 'iad1');
  vi.stubEnv('WORKFLOW_QUEUE_NAMESPACE', undefined);
  mocks.run.mockReset().mockResolvedValue({
    runId,
    deploymentId: 'dpl_pinned',
    workflowName: 'example',
    status: 'running',
  });
  mocks.retain.mockClear();
  mocks.inject.mockClear();
  mocks.send.mockClear();
  mocks.vqsRequest.mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('direct Vercel invocation', () => {
  it('separates metadata lookup from the exact POST boundary and excludes observer work before sending', async () => {
    const events: Record<string, unknown>[] = [];
    const order: string[] = [];
    const observer = (event: unknown) => {
      const value = event as Record<string, unknown>;
      events.push(value);
      order.push(`${value.phase}.${value.event}`);
    };
    const observations = channel('workflow.invocation');
    observations.subscribe(observer);
    let now = 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    let releaseRun!: (value: unknown) => void;
    mocks.run.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseRun = resolve;
        })
    );
    mocks.inject.mockImplementationOnce(async () => {
      now = 1250;
    });
    let releaseResponse!: (value: Response) => void;
    const fetch = vi.fn(() => {
      order.push('fetch');
      now = 1260;
      return new Promise<Response>((resolve) => {
        releaseResponse = resolve;
      });
    });
    vi.stubGlobal('fetch', fetch);
    try {
      const work = createInvoker({
        invoke: {
          endpoint,
          getToken: async () => {
            now = 1200;
            return 'private-token';
          },
        },
      })!(runId, payload, { idempotencyKey: 'request-timing' });
      expect(events.map((e) => `${e.phase}.${e.event}`)).toEqual([
        'lookup.begin',
      ]);
      expect(fetch).not.toHaveBeenCalled();
      now = 1100;
      releaseRun({
        runId,
        deploymentId: 'dpl_pinned',
        workflowName: 'example',
        status: 'running',
      });
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
      now = 1350;
      releaseResponse(
        new Response(encode({ ok: true, value: 'ok' }), {
          headers: { [INVOCATION_HEADER]: '1' },
        })
      );
      await expect(work).resolves.toBe('ok');
      expect(events.map((e) => [e.phase, e.event, e.at])).toEqual([
        ['lookup', 'begin', 1000],
        ['lookup', 'end', 1100],
        ['http', 'begin', 1250],
        ['http', 'end', 1350],
      ]);
      expect(order.indexOf('fetch')).toBeLessThan(order.indexOf('http.begin'));
      expect(events.every((e) => e.requestId === 'request-timing')).toBe(true);
      expect(JSON.stringify(events)).not.toContain('private-token');
      expect(events.every((e) => !('input' in e) && !('payload' in e))).toBe(
        true
      );
    } finally {
      observations.unsubscribe(observer);
    }
  });

  it('reports a failed metadata lookup without inventing an HTTP request', async () => {
    const events: Record<string, unknown>[] = [];
    const observer = (event: unknown) =>
      events.push(event as Record<string, unknown>);
    const observations = channel('workflow.invocation');
    observations.subscribe(observer);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    mocks.run.mockRejectedValue(new Error('lookup failed'));
    try {
      await expect(createInvoker(config)!(runId, payload)).rejects.toThrow(
        'lookup failed'
      );
      expect(fetch).not.toHaveBeenCalled();
      expect(events.map((e) => [e.phase, e.event, e.status])).toEqual([
        ['lookup', 'begin', undefined],
        ['lookup', 'end', 'error'],
      ]);
    } finally {
      observations.unsubscribe(observer);
    }
  });
  it('uses the raw run ID as the affinity selector without a metadata opt-in', async () => {
    expect(invocationAffinity(runId)).toBe(runId);
    mocks.run.mockResolvedValue({
      runId,
      deploymentId: 'dpl_old',
      workflowName: 'example',
      status: 'running',
    });
    const fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
      expect(new Headers(init.headers).get(AFFINITY_HEADER)).toBe(runId);
      expect(new Headers(init.headers).get(DEPLOYMENT_HEADER)).toBe('dpl_old');
      return new Response(encode({ ok: true, value: 'ok' }), {
        headers: { [INVOCATION_HEADER]: '1' },
      });
    });
    vi.stubGlobal('fetch', fetch);
    await expect(createInvoker(config)!(runId, payload)).resolves.toBe('ok');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('lets the retained owner validate input without a per-request run lookup or extra continuation', async () => {
    vi.stubEnv('WORKFLOW_RETAINED_RUNNER', '1');
    const handler = vi.fn(async () => ({ status: 'accepted' }));
    const receive = createQueue(config).createQueueHandler(
      '__wkf_workflow_',
      handler
    );
    const response = await receive(request());
    expect(response.status).toBe(200);
    expect(decode(Buffer.from(await response.arrayBuffer()))).toEqual({
      ok: true,
      value: { status: 'accepted' },
    });
    expect(mocks.run).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(mocks.vqsRequest).not.toHaveBeenCalled();
  });

  it('forwards retained-runner queue wakes to the affinitized HTTP endpoint', async () => {
    vi.stubEnv('WORKFLOW_RETAINED_RUNNER', '1');
    const fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
      expect(new Headers(init.headers).get(AFFINITY_HEADER)).toBe(
        invocationAffinity(runId)
      );
      expect(decode(Buffer.from(init.body as Uint8Array))).toMatchObject({
        kind: 'wake',
        runId,
        input: { runId },
      });
      return new Response(encode({ ok: true, value: undefined }), {
        headers: { [INVOCATION_HEADER]: '1' },
      });
    });
    vi.stubGlobal('fetch', fetch);
    const handler = vi.fn();
    const receive = createQueue(config).createQueueHandler(
      '__wkf_workflow_',
      handler
    );
    await receive(
      new Request(endpoint.replace('/invoke', '/flow'), {
        method: 'POST',
        body: encode({
          payload: { runId },
          queueName: '__wkf_workflow_example',
          deploymentId: 'dpl_pinned',
        }),
      })
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalled();
  });

  it('does not retry retained-runner persistence operations', async () => {
    vi.stubEnv('WORKFLOW_RETAINED_RUNNER', '1');
    const { withEventPostRetry } = await import('./event-retry.js');
    const operation = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    await expect(
      withEventPostRetry(operation, 'step_completed')
    ).rejects.toThrow('ECONNRESET');
    expect(operation).toHaveBeenCalledTimes(1);
  });
  it('preserves diagnostic response headers for an unavailable invocation response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('Not found', {
          status: 404,
          headers: {
            'x-vercel-id': 'iad1::request',
            'x-vercel-error': 'NOT_FOUND',
            'content-type': 'text/plain',
          },
        })
      )
    );
    await expect(
      createInvoker(config)!(runId, payload, {
        idempotencyKey: 'diagnostic-request',
      })
    ).rejects.toMatchObject({
      status: 404,
      code: 'INVOCATION_OUTCOME_UNKNOWN',
      responseStatus: 404,
      responseRequestId: 'iad1::request',
      responseErrorCode: 'NOT_FOUND',
      responseContentType: 'text/plain',
      responseProtocolVersion: null,
    });
  });
  it('returns a typed admission conflict while the original input is still processing', async () => {
    const commit = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const receiver = createDirectInvocationHandler(
      '__wkf_workflow_',
      async () => {
        entered.resolve();
        await commit.promise;
        return 'processed';
      },
      config,
      async () => {}
    );
    const first = receiver.handle(request());
    await entered.promise;
    const conflict = await receiver.handle(
      request({ ...payload, payload: new Uint8Array([99]) })
    );
    const outcome = decode(Buffer.from(await conflict.arrayBuffer()));
    expect(() => unwrapInvocationOutcome(outcome)).toThrow(EntityConflictError);
    commit.resolve();
    expect((await first).status).toBe(200);
    await Promise.all(mocks.retain.mock.calls.map(([work]) => work));
  });
  it.each([
    '',
    '/base',
  ])('keeps malformed requests on the HTTP invocation path out of VQS (%s)', async (basePath) => {
    const queue = createQueue(config);
    const handler = vi.fn();
    const receive = queue.createQueueHandler('__wkf_workflow_', handler);
    const response = await receive(
      new Request(
        `https://workflow.example.test${basePath}/.well-known/workflow/v1/invoke`,
        { method: 'POST' }
      )
    );
    expect(response.status).toBe(400);
    expect(mocks.vqsRequest).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });
  it('dispatches direct calls through createQueueHandler without VQS or response rescheduling', async () => {
    const queue = createQueue(config);
    const handler = vi.fn(async (message) =>
      message.invoke ? { timeoutSeconds: 123 } : undefined
    );
    const receive = queue.createQueueHandler('__wkf_workflow_', handler);
    const response = await receive(request());
    expect(decode(Buffer.from(await response.arrayBuffer()))).toEqual({
      ok: true,
      value: { timeoutSeconds: 123 },
    });
    await Promise.all(mocks.retain.mock.calls.map(([work]) => work));
    expect(mocks.vqsRequest).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ invoke: true }),
      expect.anything()
    );
  });

  it('does not require or add affinity on ordinary orchestration and logs every delivery', async () => {
    const queue = createQueue(config);
    await queue.queue(
      '__wkf_workflow_example',
      { runId },
      {
        deploymentId: 'dpl_pinned',
      }
    );
    expect(mocks.send.mock.calls[0][2].headers).not.toHaveProperty(
      AFFINITY_HEADER
    );
    await queue.queue('__wkf_workflow_example', {
      runId,
      stepId: 'step',
      stepName: 'step',
    });
    expect(mocks.send.mock.calls[1][2].headers).not.toHaveProperty(
      AFFINITY_HEADER
    );
    const handler = vi.fn(async () => ({ timeoutSeconds: 1 }));
    const receive = queue.createQueueHandler('__wkf_workflow_', handler);
    const normal = (affinity?: string) =>
      new Request(endpoint.replace('/invoke', '/flow'), {
        method: 'POST',
        headers: affinity ? { [AFFINITY_HEADER]: affinity } : {},
        body: encode({
          payload: { runId },
          queueName: '__wkf_workflow_example',
          deploymentId: 'dpl_pinned',
        }),
      });
    await receive(normal());
    await receive(normal('wrong'));
    await receive(normal(invocationAffinity(runId)));
    expect(handler).toHaveBeenCalledTimes(3);
    expect(mocks.send).toHaveBeenCalledTimes(5);
    const observations = vi
      .mocked(console.info)
      .mock.calls.map(([line]) => JSON.parse(line))
      .filter((entry) => entry.event === 'execution.received');
    expect(observations.map((entry) => entry.affinityStatus)).toEqual([
      'absent',
      'different',
      'match',
    ]);
    expect(
      observations.every(
        (entry) =>
          entry.runId === runId && entry.invocationId && entry.processInstanceId
      )
    ).toBe(true);
  });

  it('rejects direct requests when the feature is disabled', async () => {
    vi.stubEnv('WORKFLOW_VERCEL_INVOKE_URL', undefined);
    const queue = createQueue();
    expect(queue.invoke).toBeUndefined();
    const handler = vi.fn();
    expect(
      (await queue.createQueueHandler('__wkf_workflow_', handler)(request()))
        .status
    ).toBe(409);
    expect(handler).not.toHaveBeenCalled();
    expect(mocks.vqsRequest).not.toHaveBeenCalled();
  });
  it('sends affinity, pinned deployment, workload identity and trace context and returns binary results', async () => {
    const fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
      const headers = new Headers(init.headers);
      expect(headers.get(AFFINITY_HEADER)).toBe(invocationAffinity(runId));
      expect(headers.get(DEPLOYMENT_HEADER)).toBe('dpl_pinned');
      expect(headers.get('authorization')).toBe(`Bearer ${mocks.token}`);
      expect(headers.get('traceparent')).toMatch(/^00-/);
      const body = decode(Buffer.from(init.body as Uint8Array));
      expect(body).toMatchObject({
        runId,
        requestId: 'same-input',
        input: payload,
      });
      return new Response(
        encode({
          ok: true,
          value: { timeoutSeconds: 123, bytes: new Uint8Array([9]) },
        }),
        { headers: { [INVOCATION_HEADER]: '1' } }
      );
    });
    vi.stubGlobal('fetch', fetch);
    const invoke = createInvoker(config);
    expect(invoke).toBeDefined();
    const result = await invoke?.(runId, payload, {
      idempotencyKey: 'same-input',
    });
    expect(result).toEqual({ timeoutSeconds: 123, bytes: new Uint8Array([9]) });
    expect(fetch).toHaveBeenCalledOnce();
    expect(
      mocks.inject.mock.calls.filter(
        ([headers]) => headers.get(INVOCATION_HEADER) === '1'
      )
    ).toHaveLength(1);
  });

  it('returns typed handler errors without replacing them with transport errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            encode({
              ok: false,
              error: {
                name: 'EntityConflictError',
                message: 'changed input',
                fields: { code: 'CONFLICT' },
              },
            }),
            { headers: { [INVOCATION_HEADER]: '1' } }
          )
      )
    );
    await expect(
      createInvoker(config)?.(runId, payload)
    ).rejects.toBeInstanceOf(EntityConflictError);
  });

  it('does not send after the total timeout expires during target lookup', async () => {
    const lookup = Promise.withResolvers<unknown>();
    mocks.run.mockReturnValue(lookup.promise);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(
      createInvoker(config)?.(runId, payload, { timeoutMs: 10 })
    ).rejects.toMatchObject({ code: 'INVOCATION_OUTCOME_UNKNOWN' });
    lookup.resolve({ deploymentId: 'dpl_pinned', workflowName: 'example' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects unversioned responses and oversized inputs without retrying', async () => {
    const fetch = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetch);
    await expect(createInvoker(config)?.(runId, payload)).rejects.toMatchObject(
      { code: 'INVOCATION_OUTCOME_UNKNOWN' }
    );
    expect(fetch).toHaveBeenCalledOnce();
    fetch.mockClear();
    await expect(
      createInvoker(config)?.(runId, new Uint8Array(1024 * 1024 + 1))
    ).rejects.toMatchObject({ status: 413 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps the HTTP response pending until the mailbox handler completes', async () => {
    const commit = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const handler = vi.fn(async (input) => {
      expect(input.input).toEqual(payload);
      entered.resolve();
      await commit.promise;
      return 'processed';
    });
    const drive = vi.fn(async () => {});
    const receiver = createDirectInvocationHandler(
      '__wkf_workflow_',
      handler,
      config,
      drive
    );
    let settled = false;
    const result = receiver.handle(request()).then((response) => {
      settled = true;
      return response;
    });
    await entered.promise;
    expect(settled).toBe(false);
    expect(drive).not.toHaveBeenCalled();
    commit.resolve();
    const response = await result;
    expect(response.status).toBe(200);
    expect(decode(Buffer.from(await response.arrayBuffer()))).toEqual({
      ok: true,
      value: 'processed',
    });
    await Promise.all(mocks.retain.mock.calls.map(([work]) => work));
    expect(drive).toHaveBeenCalledOnce();
  });

  it('validates workload scope and actual deployment before invoking user code', async () => {
    const handler = vi.fn();
    const receiver = createDirectInvocationHandler(
      '__wkf_workflow_',
      handler,
      config,
      async () => {}
    );
    expect(
      (
        await receiver.handle(
          request(payload, {}, { authorization: 'Bearer invalid' })
        )
      ).status
    ).toBe(401);
    const wrongProject = await sign({ project_id: 'prj_other' });
    expect(
      (
        await receiver.handle(
          request(payload, {}, { authorization: `Bearer ${wrongProject}` })
        )
      ).status
    ).toBe(401);
    const wrongEnvironment = await sign({ environment: 'preview' });
    expect(
      (
        await receiver.handle(
          request(payload, {}, { authorization: `Bearer ${wrongEnvironment}` })
        )
      ).status
    ).toBe(401);
    expect(
      (await receiver.handle(request(payload, { deploymentId: 'dpl_wrong' })))
        .status
    ).toBe(409);
    mocks.run.mockResolvedValue({
      deploymentId: 'dpl_other',
      workflowName: 'example',
    });
    expect((await receiver.handle(request())).status).toBe(409);
    expect(handler).not.toHaveBeenCalled();
  });

  it('logs missing or different routing selectors without rejecting direct hook inputs', async () => {
    const handler = vi.fn(async () => 'accepted');
    const receiver = createDirectInvocationHandler(
      '__wkf_workflow_',
      handler,
      config,
      async () => {}
    );
    for (const [index, affinity] of [
      undefined,
      'different',
      invocationAffinity(runId),
    ].entries()) {
      const req = request(payload, { requestId: `request-${index}` });
      if (affinity) req.headers.set(AFFINITY_HEADER, affinity);
      else req.headers.delete(AFFINITY_HEADER);
      req.headers.delete(DEPLOYMENT_HEADER);
      const response = await receiver.handle(req);
      expect(response.status).toBe(200);
      expect(decode(Buffer.from(await response.arrayBuffer()))).toEqual({
        ok: true,
        value: 'accepted',
      });
    }
    expect(handler).toHaveBeenCalledTimes(3);
    const logs = vi
      .mocked(console.info)
      .mock.calls.map(([line]) => JSON.parse(line));
    expect(
      logs
        .filter((entry) => entry.event === 'direct.received')
        .map((entry) => entry.affinityStatus)
    ).toEqual(['absent', 'different', 'match']);
    expect(
      logs
        .filter((entry) => entry.event === 'direct.completed')
        .every((entry) => typeof entry.elapsedMs === 'number')
    ).toBe(true);
    expect(JSON.stringify(logs)).not.toContain(mocks.token);
    await Promise.all(mocks.retain.mock.calls.map(([work]) => work));
  });

  it('supports a real local HTTP round trip with signed workload identity and a cold mailbox', async () => {
    const handler = vi.fn(async (_message: unknown, _metadata: unknown) => ({
      completed: true,
      data: new Uint8Array([8, 9]),
    }));
    const drive = vi.fn(async () => {});
    const receiver = createDirectInvocationHandler(
      '__wkf_workflow_',
      handler,
      config,
      drive
    );
    const server = createServer(async (incoming, outgoing) => {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const response = await receiver.handle(
        new Request(endpoint, {
          method: 'POST',
          headers: incoming.headers as Record<string, string>,
          body: Buffer.concat(chunks),
        })
      );
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    try {
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('No local address');
      const invoke = createInvoker({
        invoke: { endpoint: `http://127.0.0.1:${address.port}/flow` },
      });
      await expect(invoke?.(runId, payload)).resolves.toEqual({
        completed: true,
        data: new Uint8Array([8, 9]),
      });
      expect(handler).toHaveBeenCalledOnce();
      expect(handler.mock.calls[0][1]).toMatchObject({
        messageId: expect.any(String),
        attempt: 1,
      });
      await Promise.all(mocks.retain.mock.calls.map(([work]) => work));
      expect(drive).toHaveBeenCalledWith(
        runId,
        expect.objectContaining({ queueName: '__wkf_workflow_example' })
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it('shares normal execution with direct inputs without serializing a self-hook behind its step', async () => {
    const step = Promise.withResolvers<void>();
    const driver = vi.fn(async () => step.promise);
    const receiver = createDirectInvocationHandler(
      '__wkf_workflow_',
      async () => 'accepted',
      config,
      () => driver()
    );
    const running = receiver.execute(runId, driver);
    await Promise.resolve();
    const response = await receiver.handle(request());
    expect(response.status).toBe(200);
    expect(driver).toHaveBeenCalledOnce();
    step.resolve();
    await running;
    await Promise.all(mocks.retain.mock.calls.map(([work]) => work));
  });
});
