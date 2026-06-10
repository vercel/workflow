/**
 * Capabilities table for workflow runs based on their `@workflow/core` version.
 *
 * When resuming a hook or webhook, the payload must be encoded in a format
 * that the *target* workflow run's deployment can decode. This module provides
 * a way to look up what serialization formats a given `@workflow/core` version
 * supports, so that newer deployments can avoid encoding payloads in formats
 * that older deployments don't understand (e.g., the `encr` encryption format).
 *
 * ## Adding a new format
 *
 * When a new serialization format is introduced:
 * 1. Add the format constant to `SerializationFormat` in `serialization.ts`
 * 2. Add an entry to `FORMAT_VERSION_TABLE` below with the minimum
 *    `@workflow/core` version that supports it
 * 3. The `getRunCapabilities()` function will automatically include it
 *
 * ## History
 *
 * - `encr` (AES-256-GCM encryption): added in `4.2.0-beta.64`
 *   Commit: 7618ac36 "Wire AES-GCM encryption into serialization layer (#1251)"
 *   https://github.com/vercel/workflow/commit/7618ac36
 */

import semver from 'semver';
import {
  SerializationFormat,
  type SerializationFormatType,
} from './serialization.js';
import { version as ownWorkflowCoreVersion } from './version.js';

/**
 * Capabilities of a workflow run based on its `@workflow/core` version.
 */
export interface RunCapabilities {
  /**
   * The set of serialization format prefixes that the target run can decode.
   * Use `supportedFormats.has(SerializationFormat.ENCRYPTED)` to check
   * if encryption is supported, etc.
   */
  supportedFormats: ReadonlySet<SerializationFormatType>;
  /**
   * Whether the target run's deployment understands `hookInput` on the
   * workflow queue payload (resilient `resumeHook()`). Older runtimes parse
   * the queue message with a schema that silently strips unknown fields, so
   * sending `hookInput` to them would silently drop the resume payload —
   * `resumeHook()` must fail fast (propagate the original event-write error)
   * instead of taking the resilient path for such runs.
   */
  supportsQueueHookInput: boolean;
}

/**
 * Maps serialization format identifiers to the minimum `@workflow/core`
 * version that introduced support for them. Formats not listed here are
 * assumed to be supported by all specVersion 2 runs (e.g., `devl`).
 */
const FORMAT_VERSION_TABLE: ReadonlyArray<{
  format: SerializationFormatType;
  minVersion: string;
}> = [
  { format: SerializationFormat.ENCRYPTED, minVersion: '4.2.0-beta.64' },
  // Future entries:
  // { format: SerializationFormat.CBOR, minVersion: '5.x.y' },
  // { format: SerializationFormat.ENCRYPTED_V2, minVersion: '5.x.y' },
];

/**
 * The set of formats supported by all specVersion 2 runs, regardless of
 * `@workflow/core` version. These are the baseline formats that were present
 * from the start of the specVersion 2 protocol.
 */
const BASELINE_FORMATS: ReadonlySet<SerializationFormatType> = new Set([
  SerializationFormat.DEVALUE_V1,
]);

/**
 * Minimum `@workflow/core` version whose runtime materializes `hookInput`
 * from the workflow queue payload (resilient `resumeHook()`).
 *
 * IMPORTANT: this must be the first *published* version that ships the
 * feature. If the release that includes it ends up with a different version
 * number, update this constant in the same release. Setting it too low
 * silently loses resume payloads on older deployments (their queue-payload
 * schema strips `hookInput`); setting it too high only disables the
 * resilient path (fail-fast, today's behavior), which is the safe direction.
 *
 * An exact match with our own `@workflow/core` version is also accepted in
 * `getRunCapabilities` — pre-release builds (CI tarballs, local dev) report
 * the not-yet-bumped version, and a run whose recorded version equals ours
 * was created by the same build line that is doing the resume.
 */
const QUEUE_HOOK_INPUT_MIN_VERSION = '5.0.0-beta.14';

/**
 * Look up what serialization capabilities a workflow run supports based on
 * its `@workflow/core` version string (from `executionContext.workflowCoreVersion`).
 *
 * When the version is `undefined`, not a string, or not a valid semver string
 * (e.g. very old runs that predate the field, or corrupted metadata),
 * we assume the most conservative capabilities (baseline formats only).
 */
export function getRunCapabilities(
  workflowCoreVersion: string | undefined
): RunCapabilities {
  if (!workflowCoreVersion || !semver.valid(workflowCoreVersion)) {
    return {
      supportedFormats: BASELINE_FORMATS,
      supportsQueueHookInput: false,
    };
  }

  const formats = new Set<SerializationFormatType>(BASELINE_FORMATS);

  for (const { format, minVersion } of FORMAT_VERSION_TABLE) {
    if (semver.gte(workflowCoreVersion, minVersion)) {
      formats.add(format);
    }
  }

  // See QUEUE_HOOK_INPUT_MIN_VERSION for why an exact own-version match
  // counts as supported.
  const supportsQueueHookInput =
    semver.gte(workflowCoreVersion, QUEUE_HOOK_INPUT_MIN_VERSION) ||
    workflowCoreVersion === ownWorkflowCoreVersion;

  return { supportedFormats: formats, supportsQueueHookInput };
}
