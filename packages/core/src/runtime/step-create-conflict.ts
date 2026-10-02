import { CorruptedEventLogError } from '@workflow/errors';
import type { World } from '@workflow/world';
import type { CryptoKey } from '../encryption.js';
import { runtimeLogger } from '../logger.js';
import { decodeFormatPrefix, maybeDecrypt } from '../serialization.js';
import { UNSERIALIZABLE_STEP_INPUT_MARKER } from './unserializable-step.js';

/**
 * Verify that a `step_created` the World rejected as a duplicate (409) was
 * written for the SAME step invocation this replay is trying to create.
 *
 * Correlation ids are ordinals of one per-run draw sequence, so two replays
 * that reach a `useStep` call in different orders can hand one id to two
 * different invocations. The World keeps whichever `step_created` landed
 * first, so the step body runs with the winner's arguments while the loser's
 * branch awaits the same id: its continuation then receives a result that
 * belongs to a different call. When the two calls are the same step function
 * (a fan-out mapping the same step over a list is the common shape), the
 * name check in the step consumer cannot see this, and the run completes
 * with silently cross-wired data.
 *
 * A duplicate whose persisted name and input match ours is the benign case
 * (two replays that agree on the binding raced on the write) and is
 * ignored, as before. A duplicate that persisted a different step name or a
 * different input is proof that the run's replay is non-deterministic, and
 * this throws a {@link CorruptedEventLogError} so the run fails instead of
 * continuing with the wrong result.
 *
 * Inputs are compared as plaintext bytes after decryption: the persisted
 * input and ours were both produced by `dehydrateStepArguments` from the
 * same deterministic VM state, so the same invocation yields identical
 * bytes, and AES-GCM's random nonce is the only reason the stored bytes
 * could differ for the same input.
 *
 * Verification is best-effort: when the persisted step cannot be read, or
 * either side is not in a comparable form, the duplicate is treated as
 * benign and logged, exactly like before this check existed. The check must
 * never turn a transient read failure into a failed run.
 */
export async function verifyDuplicateStepCreate({
  world,
  runId,
  correlationId,
  stepName,
  dehydratedInput,
  encryptionKey,
  conflictMessage,
}: {
  world: World;
  runId: string;
  correlationId: string;
  stepName: string;
  dehydratedInput: unknown;
  encryptionKey: CryptoKey | undefined;
  conflictMessage: string;
}): Promise<void> {
  const details = {
    workflowRunId: runId,
    correlationId,
    stepName,
    message: conflictMessage,
  };

  let persisted: { stepName: string; input?: unknown };
  try {
    persisted = await world.steps.get(runId, correlationId);
  } catch (err) {
    runtimeLogger.warn(
      'Step already exists, but the persisted step could not be read to verify it; continuing',
      { ...details, error: err instanceof Error ? err.message : String(err) }
    );
    return;
  }

  if (persisted.stepName !== stepName) {
    throw new CorruptedEventLogError(
      `Step ${correlationId} was already created as "${persisted.stepName}", but this replay invoked "${stepName}" under the same correlation id. Two replays of this run assigned the same correlation id to different step calls, so the run's replay is not deterministic.`
    );
  }

  const comparison = await compareDehydratedInputs(
    persisted.input,
    dehydratedInput,
    encryptionKey
  );

  if (comparison === 'equal') {
    runtimeLogger.info('Step already exists, continuing', details);
    return;
  }

  if (comparison === 'incomparable') {
    runtimeLogger.warn(
      'Step already exists, but its persisted input could not be compared with this replay; continuing',
      details
    );
    return;
  }

  throw new CorruptedEventLogError(
    `Step ${correlationId} ("${stepName}") was already created with different arguments than this replay passed to it. Two replays of this run assigned the same correlation id to different invocations of "${stepName}", so the step's result would be delivered to the wrong call.`
  );
}

async function compareDehydratedInputs(
  persisted: unknown,
  local: unknown,
  encryptionKey: CryptoKey | undefined
): Promise<'equal' | 'different' | 'incomparable'> {
  if (persisted === undefined || local === undefined) {
    return 'incomparable';
  }
  let a: unknown;
  let b: unknown;
  try {
    [a, b] = await Promise.all([
      maybeDecrypt(persisted, encryptionKey),
      maybeDecrypt(local, encryptionKey),
    ]);
  } catch {
    return 'incomparable';
  }
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    if (bytesEqual(a, b)) return 'equal';
    // The winner recorded the placeholder `finalizeUnserializableStep`
    // writes when a step's arguments refuse to serialize. That branch is
    // about to fail the step with the serialization error, which is the
    // outcome the user should see; do not mask it with a corruption report.
    if (isUnserializablePlaceholder(a)) return 'incomparable';
    return 'different';
  }
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    return 'incomparable';
  }
  // Legacy specVersion 1 runs store step input as plain JSON.
  try {
    return JSON.stringify(a) === JSON.stringify(b) ? 'equal' : 'different';
  } catch {
    return 'incomparable';
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function isUnserializablePlaceholder(plaintext: Uint8Array): boolean {
  try {
    const { payload } = decodeFormatPrefix(plaintext);
    return new TextDecoder()
      .decode(payload)
      .includes(UNSERIALIZABLE_STEP_INPUT_MARKER);
  } catch {
    return false;
  }
}
