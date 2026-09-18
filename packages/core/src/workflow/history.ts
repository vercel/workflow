import {
  aliasSerializationClass,
  registerSerializationClass,
} from '../class-serialization.js';
import { HISTORY_CLASS_ID, History } from '../history.js';

try {
  registerSerializationClass(HISTORY_CLASS_ID, History);
} catch {
  aliasSerializationClass(HISTORY_CLASS_ID, History);
}
export { History };
