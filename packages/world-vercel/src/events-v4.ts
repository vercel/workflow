/**
 * v4 event endpoints — header/body-split wire protocol.
 *
 * Mirrors the server-side handlers in
 * workflow-server/lib/handlers/v4/. The v4 wire format:
 *
 *   - POST: structured event metadata rides in `x-wf-*` request headers;
 *     the request body is opaque user-payload bytes streamed straight
 *     to S3 by the server. No CBOR encoding/decoding on the body — the
 *     SDK passes Uint8Array bytes through unchanged.
 *   - GET single event: response headers carry the same `x-wf-*` metadata;
 *     the response body is the raw payload bytes (streamed from S3 when
 *     stored there).
 *   - GET list: a length-prefixed binary frame stream — see
 *     `frames.ts` for the codec. Eliminates the per-event `/refs`
 *     round-trip used by v2/v3.
 *
 * Higher-level callers (the world-vercel adapter) are expected to
 * CBOR-encode their JS values into the `payload` parameter and to
 * CBOR-decode the returned `body` bytes — this module stays at the
 * wire-bytes layer.
 */

import { getVercelOidcToken } from '@vercel/oidc';
import { decode } from 'cbor-x';
import { request } from 'undici';
import { decodeFrames, V4_FRAME_CONTENT_TYPE } from './frames.js';
import { getDispatcher } from './http-client.js';
import { type APIConfig, getHttpConfig } from './utils.js';

/** Names of the `x-wf-*` headers exchanged with the server. Mirror of
 *  workflow-server/lib/handlers/v4/headers.ts `V4_HEADERS`. */
export const V4_HEADERS = {
  eventType: 'x-wf-event-type',
  specVersion: 'x-wf-spec-version',
  correlationId: 'x-wf-correlation-id',
  vercelId: 'x-wf-vercel-id',
  remoteRefBehavior: 'x-wf-remote-ref-behavior',
  deploymentId: 'x-wf-deployment-id',
  workflowName: 'x-wf-workflow-name',
  stepName: 'x-wf-step-name',
  attempt: 'x-wf-attempt',
  resumeAt: 'x-wf-resume-at',
  hookToken: 'x-wf-hook-token',
  hookIsWebhook: 'x-wf-hook-is-webhook',
  hookIsSystem: 'x-wf-hook-is-system',
  errorCode: 'x-wf-error-code',
  executionContextB64: 'x-wf-execution-context-b64',
  eventId: 'x-wf-event-id',
  runId: 'x-wf-run-id',
  createdAt: 'x-wf-created-at',
} as const;

export interface CreateEventV4Input {
  /** runId in the URL. Required for run_created too — v4 has no
   *  `/runs/null/events` shortcut because the runId is part of the S3
   *  key. Higher-level callers generate the ULID locally. */
  runId: string;
  eventType: string;
  /** Opaque payload bytes. Pass undefined for events that don't carry
   *  user data (e.g. step_started). */
  payload?: Uint8Array;
  specVersion: number;
  correlationId?: string;
  vercelId?: string;
  remoteRefBehavior?: 'resolve' | 'lazy';
  deploymentId?: string;
  workflowName?: string;
  stepName?: string;
  attempt?: number;
  resumeAt?: string;
  hookToken?: string;
  hookIsWebhook?: boolean;
  hookIsSystem?: boolean;
  errorCode?: string;
  /** Base64-encoded CBOR of the executionContext object. Use
   *  `encodeExecutionContextHeader` to produce this. */
  executionContextB64?: string;
}

export interface CreateEventV4Result {
  eventId: string;
  runId: string;
  createdAt: string;
  /**
   * Materialized-entity bag — CBOR-decoded from the response body. The
   * server hands back the same shape v2/v3 use for EventResult so the
   * adapter layer can drop these fields into its return value unchanged.
   * Keys are unset when the event type doesn't materialize that entity
   * kind.
   */
  body: {
    event?: unknown;
    run?: unknown;
    step?: unknown;
    hook?: unknown;
    wait?: unknown;
    events?: unknown[];
    cursor?: string | null;
    hasMore?: boolean;
  };
}

/** Apply structured fields onto a Headers object. Non-ASCII string fields
 *  are percent-encoded so they survive the byte-restricted header
 *  transport, matching the server-side decode. */
function applyV4Headers(headers: Headers, input: CreateEventV4Input): void {
  headers.set(V4_HEADERS.eventType, input.eventType);
  headers.set(V4_HEADERS.specVersion, String(input.specVersion));
  if (input.correlationId) {
    headers.set(V4_HEADERS.correlationId, input.correlationId);
  }
  if (input.vercelId) headers.set(V4_HEADERS.vercelId, input.vercelId);
  if (input.remoteRefBehavior) {
    headers.set(V4_HEADERS.remoteRefBehavior, input.remoteRefBehavior);
  }
  if (input.deploymentId) {
    headers.set(
      V4_HEADERS.deploymentId,
      encodeURIComponent(input.deploymentId)
    );
  }
  if (input.workflowName) {
    headers.set(
      V4_HEADERS.workflowName,
      encodeURIComponent(input.workflowName)
    );
  }
  if (input.stepName) {
    headers.set(V4_HEADERS.stepName, encodeURIComponent(input.stepName));
  }
  if (input.attempt !== undefined) {
    headers.set(V4_HEADERS.attempt, String(input.attempt));
  }
  if (input.resumeAt) {
    headers.set(V4_HEADERS.resumeAt, encodeURIComponent(input.resumeAt));
  }
  if (input.hookToken) {
    headers.set(V4_HEADERS.hookToken, encodeURIComponent(input.hookToken));
  }
  if (input.hookIsWebhook !== undefined) {
    headers.set(V4_HEADERS.hookIsWebhook, String(input.hookIsWebhook));
  }
  if (input.hookIsSystem !== undefined) {
    headers.set(V4_HEADERS.hookIsSystem, String(input.hookIsSystem));
  }
  if (input.errorCode) {
    headers.set(V4_HEADERS.errorCode, encodeURIComponent(input.errorCode));
  }
  if (input.executionContextB64) {
    headers.set(V4_HEADERS.executionContextB64, input.executionContextB64);
  }
}

async function setAuthHeader(
  headers: Headers,
  config: APIConfig | undefined
): Promise<void> {
  if (config?.token) {
    headers.set('Authorization', `Bearer ${config.token}`);
  } else {
    // Default: get an OIDC token via @vercel/oidc, same as the v3 client.
    const token = await getVercelOidcToken();
    headers.set('Authorization', `Bearer ${token}`);
  }
}

/**
 * POST /api/v4/runs/:runId/events
 *
 * Returns the event/run ids and createdAt timestamp parsed out of
 * the response headers. Throws on non-2xx responses.
 */
export async function createWorkflowRunEventV4(
  input: CreateEventV4Input,
  config?: APIConfig
): Promise<CreateEventV4Result> {
  const { baseUrl, headers: baseHeaders } = await getHttpConfig(config);
  const headers = new Headers(baseHeaders);
  headers.set('Content-Type', 'application/octet-stream');
  applyV4Headers(headers, input);
  await setAuthHeader(headers, config);

  const url = `${baseUrl}/v4/runs/${encodeURIComponent(input.runId)}/events`;
  const response = await request(url, {
    method: 'POST',
    headers: Object.fromEntries(headers.entries()),
    body: input.payload ?? undefined,
    dispatcher: getDispatcher(),
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    const errorBody = await response.body.text();
    throw new Error(
      `v4 createEvent failed: ${response.statusCode} ${errorBody}`
    );
  }

  const eventId = response.headers[V4_HEADERS.eventId];
  const runId = response.headers[V4_HEADERS.runId];
  const createdAt = response.headers[V4_HEADERS.createdAt];
  if (
    typeof eventId !== 'string' ||
    typeof runId !== 'string' ||
    typeof createdAt !== 'string'
  ) {
    throw new Error('v4 createEvent: response missing required x-wf-* headers');
  }

  // Decode the materialized-entity bag from the response body. The server
  // always returns a CBOR body now (was 204 in an earlier iteration —
  // see workflow-server PR #439 for the corresponding handler change).
  const bodyBytes = new Uint8Array(await response.body.arrayBuffer());
  const body =
    bodyBytes.byteLength > 0
      ? (decode(bodyBytes) as CreateEventV4Result['body'])
      : {};

  return { eventId, runId, createdAt, body };
}

export interface GetEventV4Result {
  eventId: string;
  runId: string;
  eventType: string;
  createdAt: string;
  correlationId?: string;
  workflowName?: string;
  stepName?: string;
  attempt?: number;
  deploymentId?: string;
  errorCode?: string;
  /** The raw payload bytes (possibly empty). Caller decodes. */
  body: Uint8Array;
}

function readHeader(
  responseHeaders: Record<string, string | string[] | undefined>,
  name: string
): string | undefined {
  const value = responseHeaders[name];
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length > 0) return value[0];
  return undefined;
}

function parseEventMetaFromHeaders(
  responseHeaders: Record<string, string | string[] | undefined>
): Omit<GetEventV4Result, 'body'> {
  const eventId = readHeader(responseHeaders, V4_HEADERS.eventId);
  const runId = readHeader(responseHeaders, V4_HEADERS.runId);
  const eventType = readHeader(responseHeaders, V4_HEADERS.eventType);
  const createdAt = readHeader(responseHeaders, V4_HEADERS.createdAt);
  if (!eventId || !runId || !eventType || !createdAt) {
    throw new Error('v4 getEvent: response missing required x-wf-* headers');
  }
  const correlationId = readHeader(responseHeaders, V4_HEADERS.correlationId);
  const workflowName = readHeader(responseHeaders, V4_HEADERS.workflowName);
  const stepName = readHeader(responseHeaders, V4_HEADERS.stepName);
  const attemptStr = readHeader(responseHeaders, V4_HEADERS.attempt);
  const deploymentId = readHeader(responseHeaders, V4_HEADERS.deploymentId);
  const errorCode = readHeader(responseHeaders, V4_HEADERS.errorCode);
  return {
    eventId,
    runId,
    eventType,
    createdAt,
    ...(correlationId ? { correlationId } : {}),
    ...(workflowName ? { workflowName: decodeURIComponent(workflowName) } : {}),
    ...(stepName ? { stepName: decodeURIComponent(stepName) } : {}),
    ...(attemptStr ? { attempt: Number(attemptStr) } : {}),
    ...(deploymentId ? { deploymentId: decodeURIComponent(deploymentId) } : {}),
    ...(errorCode ? { errorCode: decodeURIComponent(errorCode) } : {}),
  };
}

/**
 * GET /api/v4/runs/:runId/events/:eventId
 *
 * Returns the event metadata (parsed from response headers) along
 * with the payload body as a Uint8Array.
 */
export async function getEventV4(
  runId: string,
  eventId: string,
  config?: APIConfig
): Promise<GetEventV4Result> {
  const { baseUrl, headers: baseHeaders } = await getHttpConfig(config);
  const headers = new Headers(baseHeaders);
  await setAuthHeader(headers, config);

  const url = `${baseUrl}/v4/runs/${encodeURIComponent(runId)}/events/${encodeURIComponent(eventId)}`;
  const response = await request(url, {
    method: 'GET',
    headers: Object.fromEntries(headers.entries()),
    dispatcher: getDispatcher(),
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    const errorBody = await response.body.text();
    throw new Error(`v4 getEvent failed: ${response.statusCode} ${errorBody}`);
  }
  const meta = parseEventMetaFromHeaders(response.headers);
  const body = new Uint8Array(await response.body.arrayBuffer());
  return { ...meta, body };
}

export interface ListEventsV4Params {
  cursor?: string;
  limit?: number;
  sortOrder?: 'asc' | 'desc';
}

export interface ListedEventV4 {
  eventId: string;
  runId: string;
  eventType: string;
  createdAt: string;
  correlationId?: string;
  workflowName?: string;
  stepName?: string;
  attempt?: number;
  deploymentId?: string;
  errorCode?: string;
  body: Uint8Array;
}

export interface ListEventsV4Result {
  events: ListedEventV4[];
  /** Pagination cursor — present when more pages remain. */
  next?: string;
}

/**
 * GET /api/v4/runs/:runId/events
 *
 * Parses the binary-frame stream into a list of events plus the
 * pagination cursor (from the sentinel frame).
 *
 * NOTE: this implementation eagerly drains the stream into memory. A
 * streaming variant that yields events one at a time without buffering
 * the whole page is a straightforward refactor (decodeFrames is already
 * an async generator); we keep this signature for parity with the
 * existing `getWorkflowRunEvents` callers in the world-vercel adapter.
 */
export async function getWorkflowRunEventsV4(
  runId: string,
  params: ListEventsV4Params = {},
  config?: APIConfig
): Promise<ListEventsV4Result> {
  const { baseUrl, headers: baseHeaders } = await getHttpConfig(config);
  const headers = new Headers(baseHeaders);
  await setAuthHeader(headers, config);

  const searchParams = new URLSearchParams();
  if (params.cursor) searchParams.set('cursor', params.cursor);
  if (params.limit !== undefined) {
    searchParams.set('limit', String(params.limit));
  }
  if (params.sortOrder) searchParams.set('sortOrder', params.sortOrder);
  const qs = searchParams.toString();
  const url =
    `${baseUrl}/v4/runs/${encodeURIComponent(runId)}/events` +
    (qs ? `?${qs}` : '');

  const response = await request(url, {
    method: 'GET',
    headers: Object.fromEntries(headers.entries()),
    dispatcher: getDispatcher(),
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    const errorBody = await response.body.text();
    throw new Error(
      `v4 listEvents failed: ${response.statusCode} ${errorBody}`
    );
  }
  const contentType = readHeader(response.headers, 'content-type');
  if (!contentType?.startsWith(V4_FRAME_CONTENT_TYPE)) {
    throw new Error(
      `v4 listEvents: expected ${V4_FRAME_CONTENT_TYPE}, got ${contentType ?? '(none)'}`
    );
  }

  // undici's `request().body` is a Node Readable; convert to a Web
  // ReadableStream so the same decodeFrames implementation works in
  // both Node and edge runtimes.
  const webBody = (await import('node:stream')).Readable.toWeb(
    response.body as unknown as import('node:stream').Readable
  ) as unknown as ReadableStream<Uint8Array>;

  const events: ListedEventV4[] = [];
  let next: string | undefined;
  for await (const frame of decodeFrames(webBody)) {
    if (frame.meta._end === 1) {
      if (typeof frame.meta.next === 'string') next = frame.meta.next;
      break;
    }
    const meta = frame.meta as Record<string, unknown>;
    const event: ListedEventV4 = {
      eventId: String(meta.eventId ?? ''),
      runId: String(meta.runId ?? ''),
      eventType: String(meta.eventType ?? ''),
      createdAt: String(meta.createdAt ?? ''),
      body: frame.body,
    };
    if (typeof meta.correlationId === 'string') {
      event.correlationId = meta.correlationId;
    }
    if (typeof meta.workflowName === 'string') {
      event.workflowName = meta.workflowName;
    }
    if (typeof meta.stepName === 'string') event.stepName = meta.stepName;
    if (typeof meta.attempt === 'number') event.attempt = meta.attempt;
    if (typeof meta.deploymentId === 'string') {
      event.deploymentId = meta.deploymentId;
    }
    if (typeof meta.errorCode === 'string') event.errorCode = meta.errorCode;
    events.push(event);
  }

  return { events, ...(next ? { next } : {}) };
}
