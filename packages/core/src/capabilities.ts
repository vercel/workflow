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
    return { supportedFormats: BASELINE_FORMATS };
  }

  const formats = new Set<SerializationFormatType>(BASELINE_FORMATS);

  for (const { format, minVersion } of FORMAT_VERSION_TABLE) {
    if (semver.gte(workflowCoreVersion, minVersion)) {
      formats.add(format);
    }
  }

  return { supportedFormats: formats };
}
