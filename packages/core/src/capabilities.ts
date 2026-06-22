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
 * ## Adding a new non-format capability
 *
 * Some capabilities aren't serialization format prefixes — e.g.
 * byte-stream wire framing is an envelope around chunks rather than
 * a content format. For those, add a boolean field to `RunCapabilities`
 * and an entry in `CAPABILITY_VERSION_TABLE` below.
 *
 * ## History
 *
 * - `encr` (AES-256-GCM encryption): added in `4.2.0-beta.64`
 *   Commit: 7618ac36 "Wire AES-GCM encryption into serialization layer (#1251)"
 *   https://github.com/vercel/workflow/commit/7618ac36
 * - `framedByteStreams` (wire-level chunk framing for byte streams): added in `5.0.0-beta.15`
 * - `gzip` (gzip payload compression): added in `5.0.0-beta.18`
 * - `zstd` (zstd payload compression, preferred codec): added in `5.0.0-beta.18`
 *   alongside gzip — they co-ship, so any run that can read one can read both.
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

  /**
   * Whether the target run can decode wire-framed byte streams. When true,
   * byte streams (`type: 'bytes'` ReadableStreams passed across boundaries)
   * are wrapped in a length-prefixed frame envelope on the wire so the
   * reader can identify chunk boundaries — which enables auto-reconnect
   * on transient stream errors. When false, byte streams are written as
   * raw bytes (the legacy format) for compatibility with older runs.
   */
  framedByteStreams: boolean;
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
  // TODO(release): verify this matches the actual version that ships payload
  // compression. If a "Version Packages (beta)" PR merges before this change,
  // bump to the next beta. A too-low cutoff makes new producers write
  // compressed payloads to consumers that cannot decompress them; too-high
  // merely delays the optimization (safe). gzip and zstd ship together, so
  // they share a min version — a run that can read one can read both.
  { format: SerializationFormat.GZIP, minVersion: '5.0.0-beta.18' },
  { format: SerializationFormat.ZSTD, minVersion: '5.0.0-beta.18' },
  // Future entries:
  // { format: SerializationFormat.CBOR, minVersion: '5.x.y' },
  // { format: SerializationFormat.ENCRYPTED_V2, minVersion: '5.x.y' },
];

/**
 * Maps non-format capability flags (booleans on `RunCapabilities`) to the
 * minimum `@workflow/core` version that introduced support for them.
 */
const CAPABILITY_VERSION_TABLE: ReadonlyArray<{
  capability: keyof Omit<RunCapabilities, 'supportedFormats'>;
  minVersion: string;
  // TODO(release): verify this matches the actual version that ships byte-stream
  // framing. If a "Version Packages (beta)" PR merges before this change, bump
  // to the next beta. A too-low cutoff makes new producers write framed bytes to
  // consumers that cannot unframe them (silent corruption); too-high merely
  // delays the optimization (safe).
}> = [{ capability: 'framedByteStreams', minVersion: '5.0.0-beta.15' }];

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
 * we assume the most conservative capabilities (baseline formats only,
 * non-format capabilities all `false`).
 */
export function getRunCapabilities(
  workflowCoreVersion: string | undefined
): RunCapabilities {
  if (!workflowCoreVersion || !semver.valid(workflowCoreVersion)) {
    return {
      supportedFormats: BASELINE_FORMATS,
      framedByteStreams: false,
    };
  }

  const formats = new Set<SerializationFormatType>(BASELINE_FORMATS);

  for (const { format, minVersion } of FORMAT_VERSION_TABLE) {
    if (semver.gte(workflowCoreVersion, minVersion)) {
      formats.add(format);
    }
  }

  const result: RunCapabilities = {
    supportedFormats: formats,
    framedByteStreams: false,
  };

  for (const { capability, minVersion } of CAPABILITY_VERSION_TABLE) {
    if (semver.gte(workflowCoreVersion, minVersion)) {
      result[capability] = true;
    }
  }

  return result;
}
