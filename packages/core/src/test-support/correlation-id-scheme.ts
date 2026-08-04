import { afterAll, beforeAll } from 'vitest';

/**
 * Pins a test file to the run-wide shared correlation-id sequence.
 *
 * Replay tests that drive the real `workflowEntrypoint` against an event log
 * with hardcoded correlation ids can only match under the scheme those ids were
 * minted by, and the fixtures in this repo predate per-kind sequences. Files
 * whose fixture ids are derived rather than written out run under whichever
 * scheme `WORKFLOW_PER_KIND_CORRELATION_IDS` selects; per-kind minting itself is
 * covered by `correlation-id.test.ts`.
 */
export function pinSharedCorrelationIds(): void {
  let original: string | undefined;
  beforeAll(() => {
    original = process.env.WORKFLOW_PER_KIND_CORRELATION_IDS;
    process.env.WORKFLOW_PER_KIND_CORRELATION_IDS = '0';
  });
  afterAll(() => {
    if (original === undefined) {
      delete process.env.WORKFLOW_PER_KIND_CORRELATION_IDS;
    } else {
      process.env.WORKFLOW_PER_KIND_CORRELATION_IDS = original;
    }
  });
}
