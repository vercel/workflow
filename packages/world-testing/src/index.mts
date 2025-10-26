import { addition } from './addition.mjs';
import { idempotency } from './idempotency.mjs';
import { customRunId } from './custom-runid.mjs';

export function createTestSuite(pkgName: string) {
  addition(pkgName);
  idempotency(pkgName);
  customRunId(pkgName);
}
