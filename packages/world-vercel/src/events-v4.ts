/**
 * v4 event endpoints — fully framed wire protocol.
 *
 * Both directions use the same length-prefixed binary frame layout:
 *
 *   frame := [u32_be meta_len][cbor_meta][u32_be body_len][body_bytes]
 *
 * - **POST**: request body is one frame. `cbor_meta` carries structured
 *   event metadata (eventType, specVersion, deploymentId, workflowName,
 *   …, executionContext); `body_bytes` is the opaque user payload that
 *   the server streams straight to S3 without decoding.
 * - **GET single event**: response body is one frame.
 * - **LIST events**: response body is a stream of frames terminated by a
 *   sentinel frame (meta = `{_end: 1, next?: cursor}`).
 *
 * The few HTTP response headers v4 still uses (eventId / runId /
 * createdAt) are for client convenience — they let the caller read those
 * three fields without decoding the response body.
 *
 * Higher-level callers (the world-vercel adapter) CBOR-encode their JS
 * values into the `payload` parameter and CBOR-decode returned `body`
 * bytes — this module stays at the wire-bytes layer.
 */

import {
  EntityConflictError,
  RunExpiredError,
  ThrottleError,
  TooEarlyError,
  WorkflowWorldError,
} from '@workflow/errors';
import { getVercelOidcToken } from '@vercel/oidc';
import { decode } from 'cbor-x';
import { request } from 'undici';
import { decodeFrames, encodeFrame, V4_FRAME_CONTENT_TYPE } from './frames.js';
import { getDispatcher } from './http-client.js';
import { type APIConfig, getHttpConfig } from './utils.js';

/**
 * Map a v4 endpoint's non-2xx response to the same typed errors the v3
 * `makeRequest` helper produces (see utils.ts). Runtime callers branch
 * on `EntityConflictError.is(err)` / `RunExpiredError.is(err)` / etc. —
 * a plain `Error` would be treated as fatal, which broke `start()`'s
 * resilient-start path and the queue handler's idempotency tolerance.
 */
async function throwV4HttpError(
  opName: string,
  response: { statusCode: number; body: { text: () => Promise<string> } }
): Promise<never> {
  const text = await response.body.text();
  let parsed: { message?: string; error?: string } = {};
  try {
    parsed = JSON.parse(text) as { message?: string; error?: string };
  } catch {
    // body wasn't JSON — fall back to the raw status + body
  }
  const message =
    parsed.message ?? `${opName} failed: ${response.statusCode} ${text}`;
  const code = parsed.error;
  if (response.statusCode === 409) {
    throw new EntityConflictError(message);
  }
  if (response.statusCode === 410) {
    throw new RunExpiredError(message);
  }
  if (response.statusCode === 425) {
    throw new TooEarlyError(message);
  }
  if (response.statusCode === 429) {
    throw new ThrottleError(message);
  }
  throw new WorkflowWorldError(message, {
    status: response.statusCode,
    code,
  });
}

/**
 * The few HTTP response headers v4 still uses. POST surfaces these so
 * callers can read the freshly-created eventId without decoding the
 * CBOR response body. Mirror of
 * workflow-server/lib/handlers/v4/headers.ts `V4_RESPONSE_HEADERS`.
 */
export const V4_RESPONSE_HEADERS = {
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
  /** cbor-x encodes Date as CBOR tag 1 (epoch) and the server decodes it
   *  back to a Date — the round-trip is symmetric, so wait_created /
   *  step_retrying / etc. see a Date in eventData.resumeAt on the read
   *  side. */
  resumeAt?: Date;
  hookToken?: string;
  hookIsWebhook?: boolean;
  hookIsSystem?: boolean;
  errorCode?: string;
  /** Arbitrary structured map; rides as a native CBOR object in the
   *  frame meta. Bounded by the server at 2 KB encoded. */
  executionContext?: Record<string, unknown>;
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

/** Build the CBOR meta map for a v4 POST frame. Drops undefined entries
 *  so the wire shape matches what the server expects to see. */
function buildPostFrameMeta(
  input: CreateEventV4Input
): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    eventType: input.eventType,
    specVersion: input.specVersion,
  };
  if (input.correlationId !== undefined)
    meta.correlationId = input.correlationId;
  if (input.vercelId !== undefined) meta.vercelId = input.vercelId;
  if (input.remoteRefBehavior !== undefined) {
    meta.remoteRefBehavior = input.remoteRefBehavior;
  }
  if (input.deploymentId !== undefined) meta.deploymentId = input.deploymentId;
  if (input.workflowName !== undefined) meta.workflowName = input.workflowName;
  if (input.stepName !== undefined) meta.stepName = input.stepName;
  if (input.attempt !== undefined) meta.attempt = input.attempt;
  if (input.resumeAt !== undefined) meta.resumeAt = input.resumeAt;
  if (input.hookToken !== undefined) meta.hookToken = input.hookToken;
  if (input.hookIsWebhook !== undefined)
    meta.hookIsWebhook = input.hookIsWebhook;
  if (input.hookIsSystem !== undefined) meta.hookIsSystem = input.hookIsSystem;
  if (input.errorCode !== undefined) meta.errorCode = input.errorCode;
  if (input.executionContext !== undefined) {
    meta.executionContext = input.executionContext;
  }
  return meta;
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
 * Sends the full request as a single v4 frame and returns the event ids
 * + materialized-entity bag from the CBOR response body. Throws on
 * non-2xx.
 */
export async function createWorkflowRunEventV4(
  input: CreateEventV4Input,
  config?: APIConfig
): Promise<CreateEventV4Result> {
  const { baseUrl, headers: baseHeaders } = await getHttpConfig(config);
  const headers = new Headers(baseHeaders);
  headers.set('Content-Type', 'application/octet-stream');
  await setAuthHeader(headers, config);

  const frame = encodeFrame(
    buildPostFrameMeta(input),
    input.payload ?? new Uint8Array(0)
  );

  const url = `${baseUrl}/v4/runs/${encodeURIComponent(input.runId)}/events`;
  const response = await request(url, {
    method: 'POST',
    headers: Object.fromEntries(headers.entries()),
    body: frame,
    dispatcher: getDispatcher(),
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    await throwV4HttpError('v4 createEvent', response);
  }

  const eventId = response.headers[V4_RESPONSE_HEADERS.eventId];
  const runId = response.headers[V4_RESPONSE_HEADERS.runId];
  const createdAt = response.headers[V4_RESPONSE_HEADERS.createdAt];
  if (
    typeof eventId !== 'string' ||
    typeof runId !== 'string' ||
    typeof createdAt !== 'string'
  ) {
    throw new Error('v4 createEvent: response missing required x-wf-* headers');
  }

  // Decode the materialized-entity bag from the CBOR response body.
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
    await throwV4HttpError('v4 getEvent', response);
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
 * Drive a v4 frame-stream list response into an in-memory page. Used by
 * both the by-runId and by-correlationId list endpoints — the wire
 * shape is identical, only the URL differs.
 */
async function consumeListFrameStream(
  url: string,
  config: APIConfig | undefined,
  opName: string
): Promise<ListEventsV4Result> {
  const { headers: baseHeaders } = await getHttpConfig(config);
  const headers = new Headers(baseHeaders);
  await setAuthHeader(headers, config);

  const response = await request(url, {
    method: 'GET',
    headers: Object.fromEntries(headers.entries()),
    dispatcher: getDispatcher(),
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    await throwV4HttpError(`v4 ${opName}`, response);
  }
  const contentType = readHeader(response.headers, 'content-type');
  if (!contentType?.startsWith(V4_FRAME_CONTENT_TYPE)) {
    throw new Error(
      `v4 ${opName}: expected ${V4_FRAME_CONTENT_TYPE}, got ${contentType ?? '(none)'}`
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

function paginationToQuery(params: ListEventsV4Params): string {
  const sp = new URLSearchParams();
  if (params.cursor) sp.set('cursor', params.cursor);
  if (params.limit !== undefined) sp.set('limit', String(params.limit));
  if (params.sortOrder) sp.set('sortOrder', params.sortOrder);
  const qs = sp.toString();
  return qs ? `?${qs}` : '';
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
  const { baseUrl } = await getHttpConfig(config);
  const url =
    `${baseUrl}/v4/runs/${encodeURIComponent(runId)}/events` +
    paginationToQuery(params);
  return consumeListFrameStream(url, config, 'listEvents');
}

/**
 * GET /api/v4/events?correlationId=...
 *
 * Same frame stream as getWorkflowRunEventsV4 but selected by
 * correlationId (GSI) instead of runId. Used by the storage adapter's
 * `events.listByCorrelationId` path — the v3 client used
 * `/v2/events?correlationId=...` for the equivalent query.
 */
export async function getEventsByCorrelationIdV4(
  correlationId: string,
  params: ListEventsV4Params = {},
  config?: APIConfig
): Promise<ListEventsV4Result> {
  const { baseUrl } = await getHttpConfig(config);
  const sp = new URLSearchParams();
  sp.set('correlationId', correlationId);
  if (params.cursor) sp.set('cursor', params.cursor);
  if (params.limit !== undefined) sp.set('limit', String(params.limit));
  if (params.sortOrder) sp.set('sortOrder', params.sortOrder);
  const url = `${baseUrl}/v4/events?${sp.toString()}`;
  return consumeListFrameStream(url, config, 'listEventsByCorrelationId');
}
