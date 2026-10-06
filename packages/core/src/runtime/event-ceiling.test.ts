import { afterEach, describe, expect, it } from 'vitest';
import {
  isExemptFromEventCeiling,
  resolveMaxEventsLimit,
} from './event-ceiling.js';

const SNAPSHOTTING = { workflowVm: 'quickjs', snapshotThreshold: 500 };

/** A run carrying only the fields the ceiling reads. */
const run = (executionContext?: unknown) => ({ executionContext });

afterEach(() => {
  delete process.env.WORKFLOW_MAX_EVENTS_OVERRIDE;
  delete process.env.WORKFLOW_VM;
  delete process.env.WORKFLOW_SNAPSHOT_THRESHOLD;
});

describe('isExemptFromEventCeiling', () => {
  it('exempts a run stamped with QuickJS and a positive threshold', () => {
    expect(isExemptFromEventCeiling(run(SNAPSHOTTING))).toBe(true);
  });

  it('keeps the ceiling for QuickJS without snapshotting', () => {
    expect(isExemptFromEventCeiling(run({ workflowVm: 'quickjs' }))).toBe(
      false
    );
    expect(
      isExemptFromEventCeiling(
        run({ workflowVm: 'quickjs', snapshotThreshold: 0 })
      )
    ).toBe(false);
  });

  it('keeps the ceiling for the node engine, whatever the threshold', () => {
    // The threshold is only read by the QuickJS engine, so a node run with
    // one stamped still replays the whole log and still needs the ceiling.
    expect(
      isExemptFromEventCeiling(
        run({ workflowVm: 'node', snapshotThreshold: 500 })
      )
    ).toBe(false);
    expect(isExemptFromEventCeiling(run())).toBe(false);
    expect(isExemptFromEventCeiling(run(null))).toBe(false);
  });

  it('exempts a run whose policy comes from the handler env vars', () => {
    // The gap a World cannot see: `start()` only stamps the policy when the
    // *starting* deployment sets these, but the handler's values still put
    // the run on QuickJS with snapshotting.
    process.env.WORKFLOW_VM = 'quickjs';
    process.env.WORKFLOW_SNAPSHOT_THRESHOLD = '500';
    expect(isExemptFromEventCeiling(run())).toBe(true);

    // A stamped policy still wins over the env (run affinity).
    expect(
      isExemptFromEventCeiling(
        run({ workflowVm: 'quickjs', snapshotThreshold: 0 })
      )
    ).toBe(false);
    expect(isExemptFromEventCeiling(run({ workflowVm: 'node' }))).toBe(false);
  });

  it('keeps the ceiling when the handler sets QuickJS but no threshold', () => {
    process.env.WORKFLOW_VM = 'quickjs';
    expect(isExemptFromEventCeiling(run())).toBe(false);
  });

  it('keeps the ceiling for an unparseable policy instead of throwing', () => {
    // Lifting the ceiling takes positive evidence of snapshotting; both
    // resolvers throw here, and the engine reports the misconfiguration on
    // its own path.
    for (const executionContext of [
      { workflowVm: 'wasm3', snapshotThreshold: 500 },
      { workflowVm: 'quickjs', snapshotThreshold: -1 },
      { workflowVm: 'quickjs', snapshotThreshold: 1.5 },
      { workflowVm: 'quickjs', snapshotThreshold: '500' },
    ]) {
      expect(() =>
        isExemptFromEventCeiling(run(executionContext))
      ).not.toThrow();
      expect(isExemptFromEventCeiling(run(executionContext))).toBe(false);
    }

    process.env.WORKFLOW_VM = 'nope';
    expect(isExemptFromEventCeiling(run())).toBe(false);
  });
});

describe('resolveMaxEventsLimit', () => {
  it('passes the World limit through unchanged by default', () => {
    expect(resolveMaxEventsLimit(25_000, run())).toBe(25_000);
    expect(resolveMaxEventsLimit(undefined, run())).toBeUndefined();
  });

  it('drops the World limit for a snapshotting run', () => {
    expect(resolveMaxEventsLimit(25_000, run(SNAPSHOTTING))).toBeUndefined();
  });

  it('drops a limit the World advertises as MAX_SAFE_INTEGER too', () => {
    // What a server that implements the exemption itself sends, since that is
    // the largest value the deployed SDKs' `positive int` parse accepts. The
    // run is exempt either way, so the two agree.
    expect(
      resolveMaxEventsLimit(Number.MAX_SAFE_INTEGER, run(SNAPSHOTTING))
    ).toBeUndefined();
    expect(resolveMaxEventsLimit(Number.MAX_SAFE_INTEGER, run())).toBe(
      Number.MAX_SAFE_INTEGER
    );
  });

  it('keeps the World limit when there is no run to read a policy from', () => {
    process.env.WORKFLOW_VM = 'quickjs';
    process.env.WORKFLOW_SNAPSHOT_THRESHOLD = '500';
    expect(resolveMaxEventsLimit(25_000, undefined)).toBe(25_000);
  });

  it('clamps down to WORKFLOW_MAX_EVENTS_OVERRIDE', () => {
    process.env.WORKFLOW_MAX_EVENTS_OVERRIDE = '100';
    expect(resolveMaxEventsLimit(25_000, run())).toBe(100);
    expect(resolveMaxEventsLimit(50, run())).toBe(50);
    expect(resolveMaxEventsLimit(undefined, run())).toBe(100);
  });

  it('lets the override bound a snapshotting run', () => {
    // The escape hatch outranks the exemption: an operator who sets it asked
    // for a ceiling explicitly.
    process.env.WORKFLOW_MAX_EVENTS_OVERRIDE = '100';
    expect(resolveMaxEventsLimit(25_000, run(SNAPSHOTTING))).toBe(100);
    expect(resolveMaxEventsLimit(undefined, run(SNAPSHOTTING))).toBe(100);
    expect(
      resolveMaxEventsLimit(Number.MAX_SAFE_INTEGER, run(SNAPSHOTTING))
    ).toBe(100);
  });

  it('ignores an invalid override', () => {
    for (const raw of ['', '0', '-1', '1.5', 'lots']) {
      process.env.WORKFLOW_MAX_EVENTS_OVERRIDE = raw;
      expect(resolveMaxEventsLimit(25_000, run())).toBe(25_000);
      expect(resolveMaxEventsLimit(25_000, run(SNAPSHOTTING))).toBeUndefined();
    }
  });
});
