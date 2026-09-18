import {
  aliasSerializationClass,
  registerSerializationClass,
} from '../class-serialization.js';
import { SEQUENCE_CLASS_ID, Sequence } from '../sequence.js';

try {
  registerSerializationClass(SEQUENCE_CLASS_ID, Sequence);
} catch {
  aliasSerializationClass(SEQUENCE_CLASS_ID, Sequence);
}
export { Sequence };
