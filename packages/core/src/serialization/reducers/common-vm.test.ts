/**
 * Drift guard for the duplicated reducer/reviver sets.
 *
 * `common-vm.ts` intentionally duplicates `common.ts` without Node.js
 * dependencies so it can run inside the QuickJS VM. Nothing else keeps the
 * two in sync: a reducer added to `common.ts` but not here means values
 * serialize on one side of the VM boundary and fail to revive on the other,
 * at runtime, for whichever type was added.
 *
 * These tests pin the invariant that held at review time: the VM set is a
 * strict superset of the node set, adding exactly the stream/fetch types
 * that the node side handles elsewhere (workflow.ts's context-specific
 * reducers).
 */

import { describe, expect, it } from 'vitest';
import {
  getCommonReducers as getNodeReducers,
  getCommonRevivers as getNodeRevivers,
} from './common.js';
import {
  getCommonReducers as getVmReducers,
  getCommonRevivers as getVmRevivers,
} from './common-vm.js';

/**
 * Types the VM set adds on top of the node set. The node engine handles
 * these with workflow-context-specific reducers in serialization.ts
 * instead of the common set; the VM codec needs them in its common set
 * because it has no other layer.
 */
const VM_ONLY_TYPES = [
  'ReadableStream',
  'Request',
  'Response',
  'WritableStream',
];

describe('common-vm reducer/reviver drift guard', () => {
  it('VM reducers ⊇ node reducers', () => {
    const nodeKeys = Object.keys(getNodeReducers());
    const vmKeys = new Set(Object.keys(getVmReducers()));
    const missing = nodeKeys.filter((key) => !vmKeys.has(key));
    expect(
      missing,
      'reducer(s) exist in common.ts but not common-vm.ts — values of these types will serialize on the node side and fail to revive in the VM'
    ).toEqual([]);
  });

  it('VM revivers ⊇ node revivers', () => {
    const nodeKeys = Object.keys(getNodeRevivers());
    const vmKeys = new Set(Object.keys(getVmRevivers()));
    const missing = nodeKeys.filter((key) => !vmKeys.has(key));
    expect(
      missing,
      'reviver(s) exist in common.ts but not common-vm.ts — wire payloads of these types will fail to revive in the VM'
    ).toEqual([]);
  });

  it('VM-only additions are exactly the known stream/fetch types', () => {
    const nodeKeys = new Set(Object.keys(getNodeReducers()));
    const extras = Object.keys(getVmReducers())
      .filter((key) => !nodeKeys.has(key))
      .sort();
    expect(extras).toEqual(VM_ONLY_TYPES);
  });

  it('both sides bound a DataView to its viewed bytes', () => {
    // The two implementations read the view's range through different
    // primitives (hardened internal-slot getters vs. plain property reads),
    // so agreement here is worth pinning: a regression on either side puts
    // the untouched remainder of the backing buffer on the wire.
    const backing = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
    const view = new DataView(backing.buffer, 2, 3);
    const expected = Buffer.from([2, 3, 4]).toString('base64');

    expect(getNodeReducers().DataView!(view)).toBe(expected);
    expect(getVmReducers().DataView!(view)).toBe(expected);

    const revived = getVmRevivers().DataView!(expected) as DataView;
    expect(revived.byteLength).toBe(3);
    expect(Array.from(new Uint8Array(revived.buffer))).toEqual([2, 3, 4]);
  });
});
