import { createHash, randomUUID } from 'node:crypto';
import { getVercelOidcToken } from '@vercel/oidc';
import { WorkflowWorldError } from '@workflow/errors';
import {
  serializeWorkflowError,
  unwrapInvocationOutcome,
} from '@workflow/errors/invocation';
import { globalSingleton } from '@workflow/utils';
import {
  getQueueTopicPrefix,
  type InvocationOutcome,
  MessageId,
  type Queue,
  type QueuePrefix,
  resolveQueueNamespace,
  ValidQueueName,
} from '@workflow/world';
import { decode, encode } from 'cbor-x';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { z } from 'zod/v4';
import { regionForRunId } from './create-run-id.js';
import { logInvocationRouting } from './invocation-diagnostics.js';
import { createInvocationMailbox } from './invocation-mailbox.js';
import { getWorkflowRun } from './runs.js';
import {
  getSpanKind,
  injectTraceContextIntoHeaders,
  trace,
} from './telemetry.js';
import { type APIConfig, resolveClientEnvironment } from './utils.js';

export const INVOCATION_HEADER = 'x-workflow-invoke-version';
export const AFFINITY_HEADER = 'x-vercel-affinity-id';
export const DEPLOYMENT_HEADER = 'x-deployment-id';
const MAX_BYTES = 1024 * 1024;

export interface InvocationTarget {
  runId: string;
  deploymentId: string;
  region?: string;
}

export interface VercelInvokeConfig {
  /** Full execution route URL, or a resolver for deployment/region-specific routing. */
  endpoint: string | ((target: InvocationTarget) => string | Promise<string>);
  /** Workload OIDC token; ordinary Vercel API tokens are not accepted by ingress. */
  getToken?: () => Promise<string>;
}

export function invocationConfig(
  config?: APIConfig
): VercelInvokeConfig | undefined {
  return (
    config?.invoke ??
    (process.env.WORKFLOW_VERCEL_INVOKE_URL
      ? { endpoint: process.env.WORKFLOW_VERCEL_INVOKE_URL }
      : undefined)
  );
}

export function invocationAffinity(runId: string): string {
  return createHash('sha256').update(runId).digest('hex').slice(0, 32);
}

const Envelope = z.object({
  version: z.literal(1),
  runId: z.string().min(1).max(256),
  requestId: z.string().min(1).max(256),
  deploymentId: z.string().min(1),
  queueName: ValidQueueName,
  timeoutMs: z.number().int().min(1).max(120_000),
  input: z.unknown(),
});

function encodeBody(value: unknown): Buffer {
  const body = Buffer.from(encode(value));
  if (body.length > MAX_BYTES)
    throw new WorkflowWorldError('Invocation body exceeds 1 MiB', {
      status: 413,
    });
  return body;
}

async function readBody(
  body: ReadableStream<Uint8Array> | null,
  signal?: AbortSignal
): Promise<Buffer> {
  if (!body)
    throw new WorkflowWorldError('Missing invocation body', { status: 400 });
  const reader = body.getReader();
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const item = await reader.read();
      signal?.throwIfAborted();
      if (item.done) return Buffer.concat(parts);
      size += item.value.length;
      if (size > MAX_BYTES) {
        void reader.cancel().catch(() => {});
        throw new WorkflowWorldError('Invocation body exceeds 1 MiB', {
          status: 413,
        });
      }
      parts.push(item.value);
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}

function awaitSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () =>
      reject(
        new WorkflowWorldError(
          'Invocation timed out or disconnected; outcome is unknown',
          { status: 408, code: 'INVOCATION_OUTCOME_UNKNOWN' }
        )
      );
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}

async function authenticate(
  request: Request,
  config?: APIConfig
): Promise<void> {
  const token = request.headers
    .get('authorization')
    ?.match(/^Bearer (.+)$/)?.[1];
  const projectId =
    config?.projectConfig?.projectId ?? process.env.VERCEL_PROJECT_ID;
  const environment = resolveClientEnvironment(config);
  if (!token || !projectId || !environment)
    throw new WorkflowWorldError('Invocation workload identity required', {
      status: 401,
    });
  // The global Vercel key set is fixed; never discover a JWKS URL from caller input.
  const keys = globalSingleton(
    '@workflow/world-vercel//invocationJwks',
    1,
    () =>
      createRemoteJWKSet(new URL('https://oidc.vercel.com/.well-known/jwks'))
  );
  try {
    const { payload } = await jwtVerify(token, keys, {
      algorithms: ['RS256'],
      requiredClaims: ['exp', 'iss', 'project_id', 'environment'],
    });
    if (
      (payload.iss !== 'https://oidc.vercel.com' &&
        !payload.iss?.startsWith('https://oidc.vercel.com/')) ||
      payload.project_id !== projectId ||
      payload.environment !== environment
    )
      throw new Error('scope mismatch');
  } catch {
    throw new WorkflowWorldError('Invalid invocation workload identity', {
      status: 401,
    });
  }
}

export function createInvoker(
  config: APIConfig | undefined
): NonNullable<Queue['invoke']> | undefined {
  const settings = invocationConfig(config);
  if (!settings) return undefined;
  return async (runId, input, options) => {
    const requestId = options?.idempotencyKey ?? randomUUID();
    const invocationId = randomUUID();
    const timeoutMs = options?.timeoutMs ?? 30_000;
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 120_000
    )
      throw new WorkflowWorldError('Invalid invocation timeout', {
        status: 400,
      });
    const signal = AbortSignal.timeout(timeoutMs);
    const work = (async () => {
      const run = await getWorkflowRun(runId, { resolveData: 'none' }, config);
      const target = {
        runId,
        deploymentId: run.deploymentId,
        region: regionForRunId(runId) ?? undefined,
      };
      const endpoint =
        typeof settings.endpoint === 'function'
          ? await settings.endpoint(target)
          : settings.endpoint;
      const url = new URL(endpoint);
      if (
        url.protocol !== 'https:' &&
        !(
          url.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
        )
      ) {
        throw new WorkflowWorldError('Invocation endpoint must use HTTPS', {
          status: 400,
        });
      }
      const token = await (settings.getToken ?? getVercelOidcToken)();
      const payload = Envelope.parse({
        version: 1,
        runId,
        requestId,
        deploymentId: run.deploymentId,
        queueName: `${getQueueTopicPrefix('workflow', resolveQueueNamespace())}${run.workflowName}`,
        timeoutMs,
        input,
      });
      const body = encodeBody(payload);
      signal.throwIfAborted();
      return trace(
        'http POST',
        { kind: await getSpanKind('CLIENT') },
        async (span) => {
          span?.setAttributes({
            'http.request.method': 'POST',
            'server.address': url.hostname,
            'workflow.run_id': runId,
            'workflow.invocation.id': requestId,
          });
          const headers = new Headers({
            'content-type': 'application/cbor',
            accept: 'application/cbor',
            [INVOCATION_HEADER]: '1',
            [AFFINITY_HEADER]: invocationAffinity(runId),
            [DEPLOYMENT_HEADER]: run.deploymentId,
            authorization: `Bearer ${token}`,
            'x-vercel-trusted-oidc-idp-token': token,
          });
          await injectTraceContextIntoHeaders(headers);
          signal.throwIfAborted();
          // A single POST, with no retrying dispatcher and no queue fallback.
          const init: Omit<RequestInit, 'dispatcher'> & {
            dispatcher?: unknown;
          } = {
            method: 'POST',
            headers,
            body,
            signal,
            redirect: 'error',
            ...(config?.dispatcher ? { dispatcher: config.dispatcher } : {}),
          };
          const requestObservation = {
            transport: 'direct' as const,
            invocationId,
            runId,
            requestId,
            targetHost: url.hostname,
            expectedAffinityId: invocationAffinity(runId),
            sentAffinityId: invocationAffinity(runId),
            requestedDeploymentId: run.deploymentId,
          };
          logInvocationRouting('direct.send', requestObservation);
          const responseStarted = performance.now();
          const response = await fetch(url, init as RequestInit).catch(
            (cause) => {
              throw new WorkflowWorldError(
                'Invocation transport failed; outcome is unknown',
                { status: 502, code: 'INVOCATION_OUTCOME_UNKNOWN', cause }
              );
            }
          );
          span?.setAttributes({ 'http.response.status_code': response.status });
          const responseObservation = {
            responseStatus: response.status,
            responseRequestId:
              response.headers.get('x-vercel-id')?.slice(0, 256) ?? null,
            responseErrorCode:
              response.headers.get('x-vercel-error')?.slice(0, 256) ?? null,
            responseContentType:
              response.headers.get('content-type')?.slice(0, 256) ?? null,
            responseProtocolVersion:
              response.headers.get(INVOCATION_HEADER)?.slice(0, 256) ?? null,
          };
          logInvocationRouting('direct.response', {
            ...requestObservation,
            ...responseObservation,
            elapsedMs: performance.now() - responseStarted,
          });
          if (!response.ok || response.headers.get(INVOCATION_HEADER) !== '1') {
            void response.body?.cancel().catch(() => {});
            throw Object.assign(
              new WorkflowWorldError(
                'Invocation response unavailable; outcome is unknown',
                {
                  status: response.ok ? 502 : response.status,
                  code: 'INVOCATION_OUTCOME_UNKNOWN',
                }
              ),
              responseObservation,
              { targetHost: url.hostname }
            );
          }
          try {
            return decode(await readBody(response.body, signal));
          } catch (cause) {
            throw new WorkflowWorldError(
              'Invocation result unreadable; outcome is unknown',
              { status: 502, code: 'INVOCATION_OUTCOME_UNKNOWN', cause }
            );
          }
        }
      );
    })();
    // Unwrap outside transport handling so known handler errors retain their class.
    return unwrapInvocationOutcome(await awaitSignal(work, signal));
  };
}

type Handler = Parameters<Queue['createQueueHandler']>[1];
type Metadata = Parameters<Handler>[1];

export function createDirectInvocationHandler(
  prefix: QueuePrefix,
  handler: Handler,
  config: APIConfig | undefined,
  runNormal: (runId: string, metadata: Metadata) => Promise<unknown>
) {
  let mailboxPromise:
    | Promise<ReturnType<typeof createInvocationMailbox>>
    | undefined;
  const getMailbox = () =>
    (mailboxPromise ??= import('@vercel/functions').then(({ waitUntil }) =>
      createInvocationMailbox(waitUntil, (error) =>
        console.error('[workflow] Invocation continuation failed', error)
      )
    ));
  return {
    async execute(runId: string, run: () => Promise<unknown>) {
      return (await getMailbox()).execute(runId, run);
    },
    async handle(request: Request): Promise<Response> {
      const invocationId = randomUUID();
      const started = performance.now();
      const routing = {
        transport: 'direct' as const,
        invocationId,
        receivedAffinityId: request.headers.get(AFFINITY_HEADER),
        receivedDeploymentId: request.headers.get(DEPLOYMENT_HEADER),
      };
      let target: {
        runId?: string;
        requestId?: string;
        expectedAffinityId?: string;
        requestedDeploymentId?: string;
      } = {};
      try {
        if (!invocationConfig(config))
          throw new WorkflowWorldError('Direct invocation is not enabled', {
            status: 409,
          });
        if (
          request.method !== 'POST' ||
          request.headers.get(INVOCATION_HEADER) !== '1' ||
          request.headers.get('content-type') !== 'application/cbor'
        ) {
          throw new WorkflowWorldError('Invalid invocation protocol', {
            status: 400,
          });
        }
        const bodySignal = AbortSignal.any([
          request.signal,
          AbortSignal.timeout(30_000),
        ]);
        await awaitSignal(authenticate(request, config), bodySignal);
        const bytes = await awaitSignal(
          readBody(request.body, bodySignal),
          bodySignal
        );
        const input = Envelope.parse(decode(bytes));
        target = {
          runId: input.runId,
          requestId: input.requestId,
          expectedAffinityId: invocationAffinity(input.runId),
          requestedDeploymentId: input.deploymentId,
        };
        logInvocationRouting('direct.received', {
          ...routing,
          ...target,
        });
        // Selectors can be absent/consumed in transit. Check the actual deployment,
        // not whether the proxy echoed its routing headers to the application.
        if (process.env.VERCEL_DEPLOYMENT_ID !== input.deploymentId)
          throw new WorkflowWorldError('Invocation routing mismatch', {
            status: 409,
          });
        const signal = AbortSignal.any([
          request.signal,
          AbortSignal.timeout(input.timeoutMs),
        ]);
        const run = await awaitSignal(
          getWorkflowRun(input.runId, { resolveData: 'none' }, config),
          signal
        );
        if (
          run.deploymentId !== input.deploymentId ||
          input.queueName !== `${prefix}${run.workflowName}`
        )
          throw new WorkflowWorldError('Invocation target mismatch', {
            status: 409,
          });
        signal.throwIfAborted();
        const metadata: Metadata = {
          queueName: input.queueName,
          messageId: MessageId.parse(`invoke_${input.requestId}`),
          attempt: 1,
          requestId: request.headers.get('x-vercel-id') ?? undefined,
        };
        const mailbox = await awaitSignal(getMailbox(), signal);
        signal.throwIfAborted();
        let pending: Promise<InvocationOutcome>;
        try {
          pending = mailbox.submit(
            input.runId,
            input.requestId,
            createHash('sha256').update(encodeBody(input.input)).digest('hex'),
            () =>
              handler(
                {
                  runId: input.runId,
                  invoke: true,
                  requestId: input.requestId,
                  input: input.input,
                },
                metadata
              ),
            () => runNormal(input.runId, metadata)
          );
        } catch (error) {
          // Admission conflicts/overload are known rejections, not lost replies.
          return new Response(
            encodeBody({ ok: false, error: serializeWorkflowError(error) }),
            {
              headers: {
                'content-type': 'application/cbor',
                [INVOCATION_HEADER]: '1',
              },
            }
          );
        }
        const outcome = await awaitSignal(pending, signal);
        logInvocationRouting('direct.completed', {
          ...routing,
          ...target,
          elapsedMs: performance.now() - started,
          ok: outcome.ok,
        });
        return new Response(encodeBody(outcome), {
          headers: {
            'content-type': 'application/cbor',
            [INVOCATION_HEADER]: '1',
          },
        });
      } catch (error) {
        const status = WorkflowWorldError.is(error)
          ? (error.status ?? 500)
          : 400;
        logInvocationRouting('direct.failed', {
          ...routing,
          ...target,
          elapsedMs: performance.now() - started,
          status,
          ok: false,
        });
        return Response.json(
          { error: 'Invocation could not return an outcome' },
          { status }
        );
      }
    },
  };
}
