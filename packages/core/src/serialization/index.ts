/**
 * Serialization module — public API.
 *
 * Re-exports the mode-specific serialize/deserialize functions and
 * the codec/format/encryption abstractions.
 */

// Re-export types
export type {
  FormatPrefix,
  SerializableSpecial,
  Reducers,
  Revivers,
} from './types.js';
export { SerializationFormat, isFormatPrefix } from './types.js';

// Re-export codec interface and mode type
export type { Codec, SerializationMode } from './codec.js';
export { devalueCodec } from './codec-devalue.js';

// Re-export format prefix utilities
export {
  encodeWithFormatPrefix,
  decodeFormatPrefix,
  peekFormatPrefix,
  isEncrypted,
} from './format.js';

// Re-export composable encryption
export {
  encrypt,
  decrypt,
  type CryptoKey,
  type EncryptionKeyParam,
} from './encryption.js';

// Re-export mode-specific modules as namespaces
import * as workflow from './workflow.js';
import * as step from './step.js';
import * as client from './client.js';
export { workflow, step, client };

// Re-export revive helper (used by legacy compat in serialization.ts)
export { revive } from './reducers/common.js';
