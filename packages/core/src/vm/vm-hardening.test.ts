import { runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { createContext } from './index.js';

describe('VM hardening (non-weaponized regression tests)', () => {
  it('disallows eval and Function constructor inside the VM realm', () => {
    const { context } = createContext({ seed: 'poc-seed', fixedTimestamp: 0 });

    const res = runInContext(
      `
      (function(){
        const out = {};
        try { eval("1"); out.eval = "allowed"; } catch { out.eval = "blocked"; }
        try { new Function("return 1")(); out.fn = "allowed"; } catch { out.fn = "blocked"; }
        return out;
      })()
    `,
      context
    );

    expect(res).toEqual({ eval: 'blocked', fn: 'blocked' });
  });

  it('does not expose the host console object by reference', () => {
    const { globalThis: g } = createContext({
      seed: 'poc-seed',
      fixedTimestamp: 0,
    });
    expect(g.console).not.toBe(console);
  });
});
