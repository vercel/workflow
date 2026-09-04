/**
 * Type-level checks that the dynamic-source overloads resolve the way the
 * docs show them, and that adding them did not shadow the static ones.
 *
 * Every assertion lives inside a function that is never called: these are
 * compile-time checks, and actually invoking `start()` here would attempt
 * real world writes.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { Run } from './run.js';
import { start } from './start.js';

const SOURCE = `async function workflow() { "use workflow"; }`;
const steps = { fetchUser: { stepId: 'step//./src/steps//fetchUser' } };

describe('start() overload resolution', () => {
  it('returns Run<unknown> for dynamic source, with or without args', () => {
    function _check() {
      expectTypeOf(
        start(SOURCE, [{ userId: 'u_1' }], { dynamic: { steps } })
      ).toEqualTypeOf<Promise<Run<unknown>>>();
      expectTypeOf(start(SOURCE, { dynamic: { steps } })).toEqualTypeOf<
        Promise<Run<unknown>>
      >();
    }
    expect(typeof _check).toBe('function');
  });

  it('accepts dynamic.exportName alongside the shared start options', () => {
    function _check() {
      expectTypeOf(
        start(SOURCE, [], {
          dynamic: { steps, exportName: 'orchestrate' },
          attributes: { tenant: 'acme' },
        })
      ).toEqualTypeOf<Promise<Run<unknown>>>();
    }
    expect(typeof _check).toBe('function');
  });

  it('still infers the result type of a static workflow function', () => {
    function _check() {
      const workflow = Object.assign(async () => 42, {
        workflowId: 'workflow//./wf//run',
      });
      expectTypeOf(start(workflow, [])).toEqualTypeOf<Promise<Run<number>>>();
    }
    expect(typeof _check).toBe('function');
  });

  it('accepts an imported step function in dynamic.steps', () => {
    function _check() {
      // The documented call: real step imports, whose `.stepId` the
      // build-time transform stamps at runtime and never adds to their type.
      // A `{ stepId: string }`-only parameter type rejected this and accepted
      // only the escape hatch below — which is exactly what app-side e2e
      // fixtures caught, since the runner only ever used the escape hatch.
      const add = async (a: number, b: number) => a + b;
      expectTypeOf(
        start(SOURCE, [], { dynamic: { steps: { add } } })
      ).toEqualTypeOf<Promise<Run<unknown>>>();
      expectTypeOf(
        start(SOURCE, [], {
          dynamic: { steps: { add: { stepId: 'step//./steps//add' } } },
        })
      ).toEqualTypeOf<Promise<Run<unknown>>>();
    }
    expect(typeof _check).toBe('function');
  });

  it('requires `dynamic` when the first argument is source', () => {
    function _check() {
      // @ts-expect-error - source without dynamic options is not a valid call
      start(SOURCE, []);
    }
    expect(typeof _check).toBe('function');
  });
});
