import { addition } from './addition.mjs';
import { idempotency } from './idempotency.mjs';

export function createTestSuite(pkgName: string) {
  addition(pkgName);
  idempotency(pkgName);
}
