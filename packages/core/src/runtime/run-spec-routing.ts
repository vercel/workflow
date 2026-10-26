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

// A run's spec version is fixed at its creation. An entry learned from the
// run itself (`runs.get`, or a delivery's run row), from a first delivery's
// `runInput` or from a step message's `runContext` is authoritative and never
// replaced. An entry learned from an orchestrator message's `runSpecVersion`
// hint is provisional: a later hint or an authoritative source replaces it,
// so one wrong hint cannot pin the run to the wrong orchestrator for the life
// of the process. On `globalThis` so every bundled copy of the runtime shares
// it.
const remembered = globalSingleton(
  '@workflow/core//runSpecVersions',
  2,
  () => new Map<string, { specVersion: number; authoritative: boolean }>()
);

/**
 * Notes `runId`'s spec version for later deliveries in this process.
 * `authoritative` (the default) marks a version read from the run, or from a
 * field only the run's creator or its orchestrator writes; a provisional
 * version (an orchestrator message's `runSpecVersion` hint) never replaces an
 * authoritative one.
 */
export function rememberRunSpecVersion(
  runId: string,
  specVersion: number,
  { authoritative = true }: { authoritative?: boolean } = {}
) {
  const known = remembered.get(runId);
  if (known) {
    if (known.authoritative || !authoritative) {
      if (!known.authoritative) known.specVersion = specVersion;
      return;
    }
    remembered.delete(runId);
  }
  if (remembered.size >= RUN_SPEC_VERSION_CACHE_SIZE) {
    // Map iteration is insertion order: drop the oldest entry.
    const oldest = remembered.keys().next().value;
    if (oldest !== undefined) remembered.delete(oldest);
  }
  remembered.set(runId, { specVersion, authoritative });
}

/** The spec version this process remembers for `runId`, if any. */
function rememberedSpecVersion(runId: string): number | undefined {
  return remembered.get(runId)?.specVersion;
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
 * orchestrator message in `runSpecVersion`. A producer that does not know the
 * run's version leaves the hint off. A message without it (sent by such a
 * producer, one that predates the field, or the World itself) costs one
 * `runs.get`, unless this process already saw the run. A `runSpecVersion`
 * hint yields to a version this process read from the run; see
 * `rememberRunSpecVersion`. A run that cannot be
 * found takes the World's own version, and the orchestrator then handles the
 * missing run as it would any other. A run routing read is handed on, so the
 * orchestrator does not read it again.
 */
export async function resolveRunSpec(
  message: WorkflowInvokePayload
): Promise<RunSpec> {
  const stamped =
    message.runInput?.specVersion ?? message.runContext?.specVersion;
  if (stamped !== undefined) {
    rememberRunSpecVersion(message.runId, stamped);
    return { specVersion: stamped };
  }
  const known = remembered.get(message.runId);
  const hint = message.runSpecVersion;
  if (hint !== undefined) {
    // A hint is trusted unless this process read the run itself.
    if (known?.authoritative) return { specVersion: known.specVersion };
    rememberRunSpecVersion(message.runId, hint, { authoritative: false });
    return { specVersion: hint };
  }
  if (known !== undefined) return { specVersion: known.specVersion };
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
  const runSpecVersion = specVersion ?? rememberedSpecVersion(message.runId);
  return runSpecVersion === undefined
    ? payload
    : ({ ...message, runSpecVersion } as T);
}
