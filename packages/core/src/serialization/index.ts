/**
 * Serialization module — public API.
 *
 * Re-exports the mode-specific serialize/deserialize functions and
 * the codec/format/encryption abstractions.
 */

// Re-export codec interface and mode type
export type { Codec, SerializationMode } from './codec.js';
export { devalueCodec } from './codec-devalue.js';
// Re-export composable compression
export {
  COMPRESSION_MIN_BYTES,
  type CompressionCodec,
  type CompressionStats,
  compress,
  decompress,
  isCompressed,
} from './compression.js';
// Re-export composable encryption
export {
  type CryptoKey,
  decrypt,
  type EncryptionKeyParam,
  encrypt,
} from './encryption.js';

// Re-export format prefix utilities
export {
  decodeFormatPrefix,
  encodeWithFormatPrefix,
  isEncrypted,
  peekFormatPrefix,
} from './format.js';
// Re-export types
export type {
  FormatPrefix,
  Reducers,
  Revivers,
  SerializableSpecial,
} from './types.js';
export { isFormatPrefix, SerializationFormat } from './types.js';

import * as client from './client.js';
import * as step from './step.js';
// Re-export mode-specific modules as namespaces
import * as workflow from './workflow.js';
export { workflow, step, client };

// Re-export revive helper (used by legacy compat in serialization.ts)
export { revive } from './reducers/common.js';
