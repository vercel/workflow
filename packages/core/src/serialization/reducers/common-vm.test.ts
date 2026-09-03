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
  'GlobalWritableStream',
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
});
