import { test } from 'vitest';
import { inlineBatchesDebug } from '../src/inline-batches-debug.mjs';

if (process.env.WORKFLOW_INLINE_BATCHES_DEBUG === '1') {
  inlineBatchesDebug('local');
} else {
  test.skip(
    'three batches of five parallel steps — report V2 handler behavior'
  );
}
