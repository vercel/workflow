import { globalSingleton } from '@workflow/utils';

/**
 * Routing affinity for single-owner runs.
 *
 * A caller places a single-owner run with the value of its marker attribute,
 * `$experimentalSingleOwner`: a JSON object whose optional `vercelAffinity`
 * names the owner several runs of one deployment share (for example
 * `{"vercelAffinity":"cell-0"}`). Without one, the run is routed by itself.
 * The affinity ID is scoped by the run's deployment, so the same name from two
 * deployments never selects the same executor.
 *
 * The marker travels with the run (its attributes, its start input, and a
 * hook's resume context), so a process learns a run's affinity from the
 * response or input it already has, and keeps it briefly.
 */

export const SINGLE_OWNER_ATTRIBUTE = '$experimentalSingleOwner';

/** How long a learned mapping may be reused without a fresh read. */
const FRESH_MS = 60_000;
const MAX_ENTRIES = 10_000;

interface Entry {
  affinityId: string;
  at: number;
}

const routing = globalSingleton(
  '@workflow/world-vercel//runAffinity',
  2,
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

/** The marker's value, when these attributes carry one. */
export function singleOwnerMarker(
  attributes: Record<string, unknown> | undefined | null
): string | undefined {
  const value = attributes?.[SINGLE_OWNER_ATTRIBUTE];
  return typeof value === 'string' ? value : undefined;
}

/**
 * The affinity ID a single-owner run is routed with, from its marker value and
 * its deployment: `<vercelAffinity>.<deploymentId>`, or the run ID when the
 * marker names no affinity (or does not parse).
 */
export function affinityForMarker(
  runId: string,
  marker: string,
  deploymentId: string | undefined
): string {
  let name: unknown;
  try {
    name = (JSON.parse(marker) as { vercelAffinity?: unknown })?.vercelAffinity;
  } catch {
    name = undefined;
  }
  if (typeof name !== 'string' || !name || name === runId) return runId;
  return deploymentId ? `${name}.${deploymentId}` : name;
}

/**
 * Record what a response or input says about a run's routing: its marker (for
 * a single-owner run) and deployment. A run without a marker is routed by
 * itself.
 */
export function recordRunAffinity(
  runId: string,
  marker: string | undefined,
  deploymentId: string | undefined
): void {
  remember(routing, runId, {
    affinityId:
      marker === undefined
        ? runId
        : affinityForMarker(runId, marker, deploymentId),
    at: Date.now(),
  });
}

/** A recently learned affinity, if any. */
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
