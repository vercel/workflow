/**
 * In-process delivery of abort packets to the steps running beside the
 * writer.
 *
 * An abort reaches a running step as a packet on the controller's abort
 * stream. A step that runs inline, in the same process as the workflow that
 * aborted it, is also told directly, so its signal does not depend on the
 * World delivering that stream in time. That matters once the run finishes
 * while the step still runs (a race's loser): a run that asked to keep no
 * data has its streams cleared when it finishes, and the step reading its
 * abort stream after that finds an empty stream, so its signal would never
 * abort and the step would hold its upstream request and its worker after
 * the run's end.
 *
 * The packet is the one the stream carries (unframed), and the reader
 * hydrates it the same way, so the reason keeps its type and the run's
 * encryption.
 *
 * The registry lives on `globalThis`: the workflow runtime and the step code
 * reviving the signal can be separate bundles, each with its own copy of this
 * module.
 */

type Listener = (packet: Uint8Array) => void;

interface Registry {
  listeners: Map<string, Set<Listener>>;
  /**
   * Recently published packets, for a reader that starts listening after
   * the abort, e.g. a step whose arguments were still being revived. Kept
   * for {@link PUBLISHED_TTL_MS}, and at most {@link MAX_PUBLISHED}.
   */
  published: Map<string, { packet: Uint8Array; at: number }>;
}

const REGISTRY_KEY = Symbol.for('@workflow/core//localAbortDelivery');
const PUBLISHED_TTL_MS = 60_000;
const MAX_PUBLISHED = 256;

function registry(): Registry {
  const holder = globalThis as typeof globalThis & {
    [REGISTRY_KEY]?: Registry;
  };
  holder[REGISTRY_KEY] ??= { listeners: new Map(), published: new Map() };
  return holder[REGISTRY_KEY];
}

function keyOf(runId: string, streamName: string): string {
  return `${runId}\u0000${streamName}`;
}

function prune(published: Registry['published'], now: number): void {
  // Insertion order is publication order, so the expired entries lead.
  for (const [key, entry] of published) {
    if (now - entry.at < PUBLISHED_TTL_MS && published.size <= MAX_PUBLISHED)
      break;
    published.delete(key);
  }
}

/**
 * Hand an abort packet written (or about to be written) to `streamName` of
 * `runId` to every reader of that stream in this process. Never throws.
 */
export function publishLocalAbort(
  runId: string,
  streamName: string,
  packet: Uint8Array
): void {
  const { listeners, published } = registry();
  const key = keyOf(runId, streamName);
  const now = Date.now();
  published.delete(key);
  published.set(key, { packet, at: now });
  prune(published, now);
  for (const listener of listeners.get(key) ?? []) {
    try {
      listener(packet);
    } catch {
      // A reader's failure is its own; the others still get the packet.
    }
  }
}

/**
 * Listen for an abort packet published in this process to `streamName` of
 * `runId`. A packet published recently is handed over at once. Returns the
 * function that stops listening.
 */
export function onLocalAbort(
  runId: string,
  streamName: string,
  listener: Listener
): () => void {
  const { listeners, published } = registry();
  const key = keyOf(runId, streamName);
  prune(published, Date.now());
  const recent = published.get(key);
  if (recent) {
    listener(recent.packet);
    return () => {};
  }
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(listener);
  return () => {
    const current = listeners.get(key);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) listeners.delete(key);
  };
}
