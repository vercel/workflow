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

/**
 * Decoded event entity returned by GET /api/v4/runs/:runId/events/:eventId.
 * The server CBOR-encodes the full entity with refs resolved server-side,
 * so the payload field (input/output/result/error/payload/metadata
 * depending on eventType) already contains the resolved bytes — the
 * adapter layer doesn't need to splice them in.
 */
export interface DecodedV4Event {
  eventId: string;
  runId: string;
  eventType: string;
  correlationId?: string;
  createdAt: Date | string;
  specVersion?: number;
  eventData?: Record<string, unknown>;
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

/**
 * GET /api/v4/runs/:runId/events/:eventId
 *
 * Returns one v4 frame: the full event entity (CBOR-decoded from the
 * frame meta) plus the resolved payload bytes (frame body, possibly
 * empty). The wire format is identical to a single LIST frame so the
 * server can stream the payload from S3 without buffering — callers
 * are responsible for splicing `body` into `event.eventData[payloadField]`
 * when they need the resolved value. The world-vercel adapter does this
 * in events.ts.
 */
export async function getEventV4(
  runId: string,
  eventId: string,
  config?: APIConfig
): Promise<{ event: DecodedV4Event; body: Uint8Array }> {
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
  const contentType = readHeader(response.headers, 'content-type');
  if (!contentType?.startsWith(V4_FRAME_CONTENT_TYPE)) {
    throw new Error(
      `v4 getEvent: expected ${V4_FRAME_CONTENT_TYPE}, got ${contentType ?? '(none)'}`
    );
  }
  const webBody = (await import('node:stream')).Readable.toWeb(
    response.body as unknown as import('node:stream').Readable
  ) as unknown as ReadableStream<Uint8Array>;

  // GET emits a single frame (no sentinel); decodeFrames returns at EOF
  // after yielding it.
  for await (const frame of decodeFrames(webBody)) {
    return { event: frame.meta as unknown as DecodedV4Event, body: frame.body };
  }
  throw new Error(`v4 getEvent: empty frame stream for ${eventId}`);
}

export interface ListEventsV4Params {
  cursor?: string;
  limit?: number;
  sortOrder?: 'asc' | 'desc';
}

/**
 * A single event extracted from a v4 LIST frame. Mirrors `DecodedV4Event`
 * but also carries the raw payload bytes — for payload-bearing events the
 * server emits the resolved bytes in the frame body (so it never has to
 * decode them) and the SDK is expected to splice them back into the
 * appropriate `eventData` field.
 */
export interface ListedEventV4 {
  event: DecodedV4Event;
  /** Resolved payload bytes. Empty for events without a payload. */
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
 * pagination cursor (from the sentinel frame). Each frame's CBOR meta
 * IS the full event entity, with the payload field still in `eventData`
 * as a `RefDescriptor` (lazy); the resolved payload bytes ride in the
 * frame body. The adapter layer splices them back into eventData.
 *
 * Eagerly drains the stream into memory to match the existing
 * `getWorkflowRunEvents` page-at-a-time contract. A streaming variant
 * that yields events one at a time without buffering the page would be
 * a small refactor (decodeFrames is already async-iterable).
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
    events.push({
      event: frame.meta as unknown as DecodedV4Event,
      body: frame.body,
    });
  }

  return { events, ...(next ? { next } : {}) };
}
