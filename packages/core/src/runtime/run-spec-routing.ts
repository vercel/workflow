import { WorkflowRunNotFoundError } from '@workflow/errors';
import { globalSingleton } from '@workflow/utils';
import {
  SPEC_VERSION_LEGACY,
  type WorkflowInvokePayload,
  type WorkflowRun,
} from '@workflow/world';
import { trace } from '../telemetry.js';
import { getWorld } from './world.js';

/** How many runs' spec versions a process remembers. */
export const RUN_SPEC_VERSION_CACHE_SIZE = 10_000;

// A run's spec version is fixed at its creation, so a remembered one never
// goes stale. On `globalThis` so every bundled copy of the runtime shares it.
const remembered = globalSingleton(
  '@workflow/core//runSpecVersions',
  1,
  () => new Map<string, number>()
);

/** Notes `runId`'s spec version for later deliveries in this process. */
export function rememberRunSpecVersion(runId: string, specVersion: number) {
  if (remembered.has(runId)) return;
  if (remembered.size >= RUN_SPEC_VERSION_CACHE_SIZE) {
    // Map iteration is insertion order: drop the oldest entry.
    const oldest = remembered.keys().next().value;
    if (oldest !== undefined) remembered.delete(oldest);
  }
  remembered.set(runId, specVersion);
}

/** The spec version of a message's run, and the run when it had to be read. */
export interface RunSpec {
  specVersion: number;
  /** The run (`resolveData: 'none'`), when routing read it. */
  run?: WorkflowRun;
}

/**
 * The spec version of the run `message` belongs to, which picks the
 * orchestrator that handles it.
 *
 * Every producer in this runtime says which on the message: the run's first
 * delivery in `runInput`, a step message in `runContext`, every other
 * orchestrator message in `runSpecVersion`. A message without it (sent by a
 * producer that predates the field, or by the World itself) costs one
 * `runs.get`, unless this process already saw the run. A run that cannot be
 * found takes the World's own version, and the orchestrator then handles the
 * missing run as it would any other. A run routing read is handed on, so the
 * orchestrator does not read it again.
 */
export async function resolveRunSpec(
  message: WorkflowInvokePayload
): Promise<RunSpec> {
  const carried =
    message.runInput?.specVersion ??
    message.runContext?.specVersion ??
    message.runSpecVersion;
  if (carried !== undefined) {
    rememberRunSpecVersion(message.runId, carried);
    return { specVersion: carried };
  }
  const known = remembered.get(message.runId);
  if (known !== undefined) return { specVersion: known };
  const world = await getWorld();
  try {
    const run = (await trace('workflow.route.resolve_spec', () =>
      world.runs.get(message.runId, { resolveData: 'none' })
    )) as WorkflowRun | undefined;
    if (!run) return { specVersion: world.specVersion };
    const specVersion = run.specVersion ?? SPEC_VERSION_LEGACY;
    rememberRunSpecVersion(message.runId, specVersion);
    return { specVersion, run };
  } catch (error) {
    if (WorkflowRunNotFoundError.is(error)) {
      return { specVersion: world.specVersion };
    }
    throw error;
  }
}

/**
 * `payload` with its run's spec version as the routing hint
 * (`runSpecVersion`), for an orchestrator message: `specVersion` when the
 * producer passed the run's version as a queue option, else the version this
 * process remembers for the run. Unchanged when neither is known, when it is
 * not a run's message, or when it already carries the hint.
 */
export function withRunSpecVersion<T>(payload: T, specVersion?: number): T {
  if (typeof payload !== 'object' || payload === null) return payload;
  const message = payload as Record<string, unknown>;
  if (typeof message.runId !== 'string' || 'runSpecVersion' in message) {
    return payload;
  }
  const runSpecVersion = specVersion ?? remembered.get(message.runId);
  return runSpecVersion === undefined
    ? payload
    : ({ ...message, runSpecVersion } as T);
}
