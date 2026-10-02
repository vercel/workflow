import { globalSingleton } from '@workflow/utils';

/**
 * Routing affinity for runs (experimental shared cells).
 *
 * workflow-server owns the mapping from a run to the affinity ID its
 * invocations are routed with: the run ID itself, or a shared cell that
 * several runs of one deployment are packed into. Callers never compute or
 * persist it. They use an ID taken from a recent server response for the run
 * (run creation, run read or hook lookup) and forget it quickly, so a moved
 * run is picked up from the next fresh response. The owner states the ID it
 * was invoked under on its eventsync handshake, where the server verifies it.
 */

/** How long a server-provided mapping may be reused without a fresh read. */
const FRESH_MS = 60_000;
const MAX_ENTRIES = 10_000;
const MAX_CELL_SIZE = 1000;

interface Entry {
  affinityId: string;
  at: number;
}

const routing = globalSingleton(
  '@workflow/world-vercel//runAffinity',
  1,
  () => new Map<string, Entry>()
);

const owned = globalSingleton(
  '@workflow/world-vercel//ownerAffinity',
  1,
  () => new Map<string, string>()
);

function remember(map: Map<string, unknown>, key: string, value: unknown) {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

/**
 * Cell size requested for new runs, from `WORKFLOW_AFFINITY_CELL_SIZE`.
 * Unset or invalid means per-run affinity (no cell).
 */
export function affinityCellSize(): number | undefined {
  const raw = process.env.WORKFLOW_AFFINITY_CELL_SIZE?.trim();
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const size = Number(raw);
  return size >= 1 && size <= MAX_CELL_SIZE ? size : undefined;
}

/** Record the affinity a server response reported for a run. A response
 * without one is from a server (or run) without cells: per-run affinity. */
export function recordRunAffinity(runId: string, affinityId?: unknown): void {
  remember(routing, runId, {
    affinityId:
      typeof affinityId === 'string' && affinityId ? affinityId : runId,
    at: Date.now(),
  });
}

/** A recently server-reported affinity, if any. */
export function freshRunAffinity(runId: string): string | undefined {
  const entry = routing.get(runId);
  if (!entry) return undefined;
  if (Date.now() - entry.at > FRESH_MS) {
    routing.delete(runId);
    return undefined;
  }
  return entry.affinityId;
}

/** Drop a mapping that an owner reported as wrong. */
export function forgetRunAffinity(runId: string): void {
  routing.delete(runId);
}

/** Owner side: the affinity this process was invoked under for a run. */
export function noteOwnerAffinity(runId: string, affinityId: string): void {
  remember(owned, runId, affinityId);
}

export function ownerAffinity(runId: string): string | undefined {
  return owned.get(runId);
}
