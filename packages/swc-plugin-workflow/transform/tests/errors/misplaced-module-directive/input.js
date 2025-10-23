// This should error - directive after import
import { something } from './module';

'use step';

export async function test() {
  return 42;
}
