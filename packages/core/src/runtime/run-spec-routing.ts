import { WorkflowRunNotFoundError } from '@workflow/errors';
import {
  SPEC_VERSION_LEGACY,
  type WorkflowInvokePayload,
  type WorkflowRun,
} from '@workflow/world';
import { trace } from '../telemetry.js';
import { getWorld } from './world.js';

/** The spec version of a message's run, and the run when it had to be read. */
export interface RunSpec {
  specVersion: number;
  /** The run (`resolveData: 'none'`), when routing read it. */
  run?: WorkflowRun;
}

/**
 * The spec version of the run `message` belongs to, which picks the
 * orchestrator that handles it. In order:
 *
 * 1. `runInput.specVersion` (a run's first delivery, from `start()`) or
 *    `runContext.specVersion` (a step message), which the run's creator or
 *    its orchestrator wrote from the run itself.
 * 2. The `runSpecVersion` hint, which every other producer in this runtime
 *    stamps on the orchestrator messages it sends, from the run row or from
 *    the delivery that sends them.
 * 3. `runs.get`, for a message that carries neither. That covers a producer
 *    that does not know the run's version (`resumeHook()` on a hook that
 *    records none), a World's own message for a run that records none, and
 *    producers that predate the fields. A run without a stored version is
 *    `SPEC_VERSION_LEGACY`. A run that cannot be found takes the World's own
 *    version, and the orchestrator then handles the missing run as it would
 *    any other. The run read here is handed on, so the orchestrator does not
 *    read it again.
 *
 * A wrong hint routes the message to the other orchestrator, which finds the
 * run's own version on the row it loads and hands the message on (see
 * `handOffToRunOrchestrator`).
 *
 * Producers outside this runtime (an older SDK, or another client of the
 * World) may send a message for a spec 9 run that is unstamped or stamped
 * below 9. Nothing here can prevent that. Such a message is routed to the
 * right orchestrator: an unstamped one through `runs.get`, a low hint
 * through the hand-off once the run is loaded. But the World has already
 * treated it as a message of an earlier run (see `messageRunSpecVersion` in
 * `@workflow/world`): world-vercel sends it without the run's concurrency key,
 * and world-local and world-postgres do not serialize it, so it can run beside
 * the run's serialized orchestrator. The in-band fence keeps the run's log
 * correct: the second writer's in-band write is refused. The cost is wasted
 * orchestrator work, which can include running the body of an inline step
 * the other delivery is still running; it does not corrupt the log.
 */
export async function resolveRunSpec(
  message: WorkflowInvokePayload
): Promise<RunSpec> {
  const stamped =
    message.runInput?.specVersion ??
    message.runContext?.specVersion ??
    message.runSpecVersion;
  if (stamped !== undefined) return { specVersion: stamped };
  const world = await getWorld();
  try {
    const run = (await trace('workflow.route.resolve_spec', () =>
      world.runs.get(message.runId, { resolveData: 'none' })
    )) as WorkflowRun | undefined;
    if (!run) return { specVersion: world.specVersion };
    return { specVersion: run.specVersion ?? SPEC_VERSION_LEGACY, run };
  } catch (error) {
    if (WorkflowRunNotFoundError.is(error)) {
      return { specVersion: world.specVersion };
    }
    throw error;
  }
}

/**
 * `payload` with `specVersion` as its routing hint (`runSpecVersion`), for an
 * orchestrator message whose producer passed the run's version as a queue
 * option. Unchanged when no version was passed, when it is not a run's
 * message, or when it already carries the hint.
 */
export function withRunSpecVersion<T>(payload: T, specVersion?: number): T {
  if (specVersion === undefined) return payload;
  if (typeof payload !== 'object' || payload === null) return payload;
  const message = payload as Record<string, unknown>;
  if (typeof message.runId !== 'string' || 'runSpecVersion' in message) {
    return payload;
  }
  return { ...message, runSpecVersion: specVersion } as T;
}
