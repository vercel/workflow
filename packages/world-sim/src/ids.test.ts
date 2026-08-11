import { ulidToDate, workflowRunIdSchema } from '@workflow/world';
import { describe, expect, it } from 'vitest';
import { createIdFactory } from './ids.js';

describe('deterministic id factory', () => {
  it('mints run ids the rest of the SDK accepts as ULIDs', () => {
    let now = 1_704_067_200_000;
    const ids = createIdFactory(() => now);
    const runId = ids.runId();
    expect(workflowRunIdSchema.safeParse(runId).success).toBe(true);
    // `runIdCreatedAt` decodes this to seed the workflow VM's fixed clock, so
    // the embedded timestamp has to be the virtual time, not the host's.
    expect(ulidToDate(runId.slice('wrun_'.length))?.getTime()).toBe(now);

    now += 5_000;
    expect(ulidToDate(ids.runId().slice('wrun_'.length))?.getTime()).toBe(now);
  });

  it('sorts by (time, mint order), which is what event-log ordering relies on', () => {
    let now = 1_704_067_200_000;
    const ids = createIdFactory(() => now);
    const a = ids.eventId();
    const b = ids.eventId();
    now += 1;
    const c = ids.eventId();
    expect(a < b).toBe(true);
    expect(b < c).toBe(true);
  });

  it('is a pure function of (clock, counter)', () => {
    const build = () => {
      const ids = createIdFactory(() => 1_704_067_200_000);
      return [ids.runId(), ids.eventId(), ids.messageId()];
    };
    expect(build()).toEqual(build());
  });
});
