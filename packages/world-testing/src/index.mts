import { addition } from './addition.mjs';
import { hooks } from './hooks.mjs';
import { idempotency } from './idempotency.mjs';
import { nullByte } from './null-byte.mjs';

export function createTestSuite(pkgName: string) {
  addition(pkgName);
  idempotency(pkgName);
  hooks(pkgName);
  nullByte(pkgName);
}
