import { addition } from './addition.mjs';
import { errors } from './errors.mjs';
import { eventIds } from './event-ids.mjs';
import { hooks } from './hooks.mjs';
import { idempotency } from './idempotency.mjs';
import { inBandFence } from './in-band-fence.mjs';
import { inlineExecution } from './inline-execution.mjs';
import { lineage } from './lineage.mjs';
import { nullByte } from './null-byte.mjs';
import { resolveData } from './resolve-data.mjs';

export function createTestSuite(pkgName: string) {
  addition(pkgName);
  eventIds(pkgName);
  idempotency(pkgName);
  inBandFence(pkgName);
  hooks(pkgName);
  nullByte(pkgName);
  errors(pkgName);
  inlineExecution(pkgName);
  lineage(pkgName);
  resolveData(pkgName);
}
