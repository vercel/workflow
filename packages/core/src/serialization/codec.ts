/**
 * Codec interface for serialization formats.
 *
 * A codec handles the core serialize/deserialize logic for a specific
 * wire format (devalue, CBOR, JSON, etc.). Each codec is responsible
 * for handling all supported data types internally — the caller only
 * specifies which serialization mode to use.
 *
 * - **devalue**: Uses custom reducers/revivers for Date, Error, Map, Set,
 *   typed arrays, class instances, etc.
 * - **cbor**: Would handle Date, typed arrays, Map, Set natively via the
 *   CBOR type system. Class instances would still need custom handling.
 * - **json**: Would only support standard JSON types (primitives, arrays,
 *   plain objects). No Date, Map, Set, typed arrays, etc.
 */

import type { CompressionStats } from './compression.js';
import type { FormatPrefix } from './types.js';

/**
 * The serialization mode determines which types are supported and how
 * they're handled. Different modes compose different sets of type handlers.
 *
 * - `workflow`: Runs inside the workflow VM. Includes class serialization,
 *   step function serialization. No stream handling.
 * - `step`: Runs in the step handler (Node.js). Includes class serialization.
 *   No step function serialization. Stream handling at call sites.
 * - `client`: Runs on the client side. Includes class serialization.
 *   No step function serialization. Stream handling at call sites.
 */
export type SerializationMode = 'workflow' | 'step' | 'client';

/**
 * Options passed to codec serialize/deserialize to support VM-context
 * serialization and mode-specific type handling.
 */
export interface CodecOptions {
  /**
   * The global object to use for `instanceof` checks and constructors.
   * Defaults to `globalThis`. Must be set to the VM's global when
   * serializing/deserializing data that crosses VM boundaries.
   */
  global?: Record<string, any>;

  /**
   * Additional reducers to merge into the mode's default reducers.
   * Used by dehydrate/hydrate functions that need stream handling
   * or other mode-specific type reducers.
   */
  extraReducers?: Record<string, (value: any) => any>;

  /**
   * Additional revivers to merge into the mode's default revivers.
   * Used by dehydrate/hydrate functions that need stream handling
   * or other mode-specific type revivers.
   */
  extraRevivers?: Record<string, (value: any) => any>;

  /**
   * Whether to gzip-compress the serialized payload (write side only;
   * reads always handle both compressed and uncompressed data). Must
   * only be enabled when the target run supports compressed payloads:
   * run specVersion >= SPEC_VERSION_SUPPORTS_COMPRESSION, and for
   * cross-deployment writes the target deployment's capabilities (see
   * `getRunCapabilities` in capabilities.ts). Defaults to `false`.
   */
  compression?: boolean;

  /**
   * Optional telemetry sink populated by the compression layer with what
   * it did to the payload (whether it compressed, logical vs stored size).
   * Used by the dehydrate/hydrate wrappers to emit OTel span attributes.
   */
  compressionStats?: CompressionStats;
}

export interface Codec {
  /** The 4-character format prefix identifier (e.g. "devl", "cbor", "json") */
  readonly formatPrefix: FormatPrefix;

  /**
   * Serialize a value to bytes.
   *
   * The codec handles all supported types internally based on the mode.
   *
   * @param value - The value to serialize
   * @param mode - The serialization mode
   * @param options - Optional global, extra reducers/revivers
   * @returns The serialized payload (without format prefix)
   */
  serialize(
    value: unknown,
    mode: SerializationMode,
    options?: CodecOptions
  ): Uint8Array;

  /**
   * Deserialize bytes back to a value.
   *
   * The codec handles all supported types internally based on the mode.
   *
   * @param data - The serialized payload (without format prefix)
   * @param mode - The serialization mode
   * @param options - Optional global, extra revivers
   * @returns The deserialized value
   */
  deserialize(
    data: Uint8Array,
    mode: SerializationMode,
    options?: CodecOptions
  ): unknown;

  /**
   * Deserialize legacy (pre-format-prefix) data.
   * Used for backwards compatibility with specVersion 1 runs that stored
   * data as plain JSON arrays instead of binary.
   *
   * @param data - The legacy data
   * @param mode - The serialization mode
   * @param options - Optional global, extra revivers
   * @returns The deserialized value
   */
  deserializeLegacy?(
    data: unknown,
    mode: SerializationMode,
    options?: CodecOptions
  ): unknown;
}
