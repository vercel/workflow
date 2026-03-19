import { addition } from './addition.mjs';
import { errors } from './errors.mjs';
import { hooks } from './hooks.mjs';
import { idempotency } from './idempotency.mjs';
export { createLimitsContractSuite } from './limits-contract.js';
export { createLimitsRuntimeSuite } from './limits-runtime.js';
import { nullByte } from './null-byte.mjs';

export function createTestSuite(pkgName: string) {
  addition(pkgName);
  idempotency(pkgName);
  hooks(pkgName);
  nullByte(pkgName);
  errors(pkgName);
}
