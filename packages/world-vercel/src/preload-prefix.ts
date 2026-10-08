/**
 * Tail-only preload, client half: turn the runtime's cached log prefix
 * (`CreateEventParams.preloadPrefix`) into the `meta.preloadClaim` the backend
 * verifies, decide from the response headers whether it was honored, and
 * remember backends that do not understand claims.
 *
 * The backend protocol and the guards it carries are model-checked in
 * workflow-server `specs/LogPrefixCache.tla`. What this module owns is the
 * client's side of the claim shape: it claims exactly slots `1..N` of what it
 * was handed, and it only accepts a response whose base header names that N.
 * The fill rules (dense from slot 1, first load held `run_started`, sealed-log
 * run) are the runtime's, which decides what to cache in the first place.
 */
import { globalSingleton } from '@workflow/utils';
import {
  type Event,
  eventIdToSlot,
  FIRST_EVENT_SLOT,
  type PreloadPrefix,
} from '@workflow/world';

/** Response header: the slot the streamed log starts after (honored claim). */
export const PRELOAD_BASE_HEADER = 'x-wf-preload-base';
/**
 * Response header: `honored` or `refused:<reason>`. Present whenever a backend
 * that understands claims received one, so its absence identifies a backend
 * that predates the protocol.
 */
export const PRELOAD_CLAIM_HEADER = 'x-wf-preload-claim';

/** Sealed-log runs (spec >= 7) are the only ones the backend serves tails for. */
const SEALED_LOG_SPEC_VERSION = 7;

/** `meta.preloadClaim` on the wire. */
export interface PreloadClaimWire {
  slot: number;
  eventType: string;
  correlationId?: string;
  createdAt?: number;
  specVersion: number;
  runStartedSlot: number;
}

/**
 * The claim for `prefix`, or undefined when it is not one this module will
 * send: not exactly slots `1..N` in order, missing `run_created` at slot 1 or
 * `run_started` inside it, or not a sealed-log run. Defensive: the runtime
 * already enforces all of this before it caches a prefix.
 */
export function preloadClaimFor(
  prefix: PreloadPrefix
): PreloadClaimWire | undefined {
  const { events } = prefix;
  if (events.length < 2) return undefined;
  let runStartedSlot: number | undefined;
  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    if (eventIdToSlot(event.eventId) !== FIRST_EVENT_SLOT + index) {
      return undefined;
    }
    if (event.eventType === 'run_started' && runStartedSlot === undefined) {
      runStartedSlot = FIRST_EVENT_SLOT + index;
    }
  }
  const runCreated = events[0];
  if (runCreated.eventType !== 'run_created') return undefined;
  if (runStartedSlot === undefined) return undefined;
  const specVersion = runCreated.specVersion;
  if (
    typeof specVersion !== 'number' ||
    specVersion < SEALED_LOG_SPEC_VERSION
  ) {
    return undefined;
  }
  const anchor = events[events.length - 1];
  const createdAt =
    anchor.createdAt instanceof Date ? anchor.createdAt.getTime() : undefined;
  return {
    slot: events.length,
    eventType: anchor.eventType,
    ...(anchor.correlationId ? { correlationId: anchor.correlationId } : {}),
    ...(createdAt !== undefined && Number.isFinite(createdAt)
      ? { createdAt }
      : {}),
    specVersion,
    runStartedSlot,
  };
}

/**
 * How a response answered a claim:
 * - `honored`: its frames are the log strictly after `claim.slot`.
 * - `refused`: a backend that understands claims sent the full log.
 * - `unsupported`: a backend that predates claims sent the full log.
 * - `mismatch`: a base header naming another slot. The frames cannot be
 *   composed with the prefix; the caller reloads in full.
 */
export type PreloadClaimResponse =
  | 'honored'
  | 'refused'
  | 'unsupported'
  | 'mismatch';

export function classifyPreloadClaimResponse(
  headers: Headers,
  claim: PreloadClaimWire
): PreloadClaimResponse {
  const base = headers.get(PRELOAD_BASE_HEADER);
  if (base !== null) {
    return Number(base) === claim.slot ? 'honored' : 'mismatch';
  }
  return headers.get(PRELOAD_CLAIM_HEADER) === null ? 'unsupported' : 'refused';
}

/**
 * Backends (by base URL) whose responses carried no claim header, and when.
 * A claim costs such a backend nothing (it ignores unknown meta), but building
 * one costs the client a copy of the prefix, so it is skipped for
 * {@link PRELOAD_CLAIM_REPROBE_MS} and then tried again, so a long-lived
 * process picks the protocol up once the backend deploys it.
 *
 * On `globalThis` (see `globalSingleton`) so every bundled copy of this
 * module shares what one copy learned.
 */
const preloadClaimSupport = globalSingleton(
  '@workflow/world-vercel//preloadClaimSupport',
  1,
  () => ({ unsupportedSince: new Map<string, number>() })
);

/** How long a backend without claim support is remembered. */
export const PRELOAD_CLAIM_REPROBE_MS = 10 * 60_000;

export function preloadClaimKnownUnsupported(baseUrl: string): boolean {
  const since = preloadClaimSupport.unsupportedSince.get(baseUrl);
  if (since === undefined) return false;
  if (Date.now() - since < PRELOAD_CLAIM_REPROBE_MS) return true;
  preloadClaimSupport.unsupportedSince.delete(baseUrl);
  return false;
}

export function notePreloadClaimResponse(
  baseUrl: string,
  response: PreloadClaimResponse
): void {
  if (response === 'unsupported') {
    preloadClaimSupport.unsupportedSince.set(baseUrl, Date.now());
  } else {
    preloadClaimSupport.unsupportedSince.delete(baseUrl);
  }
}

/** Test hook: forget which backends lack claim support. */
export function resetPreloadClaimSupportForTests(): void {
  preloadClaimSupport.unsupportedSince.clear();
}

/**
 * The prefix a stream is composed onto, and the checks the composed result
 * must pass to equal a full load: the first tail event sits at slot N + 1,
 * and an empty tail ends at slot N's cursor.
 */
export interface PreloadComposition {
  readonly events: readonly Event[];
  readonly slot: number;
  readonly cursor: string;
}

export function preloadComposition(
  prefix: PreloadPrefix,
  claim: PreloadClaimWire
): PreloadComposition {
  const last = prefix.events[prefix.events.length - 1];
  return {
    events: prefix.events,
    slot: claim.slot,
    cursor: `eid:${last.eventId}`,
  };
}

/**
 * Thrown when an honored stream does not compose with the prefix (a first
 * tail event above or below N + 1, or an empty tail ending anywhere but slot
 * N). The model says a correct backend never does this; the caller reloads
 * the full log, which is always safe because both preload writes are
 * idempotent.
 */
export class PreloadCompositionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PreloadCompositionError';
  }
}
