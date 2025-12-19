import * as vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { createContext } from './index.js';

const seed = 'entropy seed';
const fixedTimestamp = 1234567890000;

describe('createContext', () => {
  it('should have a deterministic `Math.random()` function', () => {
    const { context } = createContext({ seed, fixedTimestamp });

    expect(vm.runInContext('Math.random()', context)).toEqual(
      0.45558666071890863
    );
    expect(vm.runInContext('Math.random()', context)).toEqual(
      0.17985294630429577
    );
    expect(vm.runInContext('Math.random()', context)).toEqual(
      0.37680233072529035
    );
  });

  it('should have deterministic `Date.now()`', () => {
    const { context } = createContext({ seed, fixedTimestamp });

    expect(vm.runInContext('Date.now()', context)).toEqual(fixedTimestamp);
    expect(vm.runInContext('Date.now()', context)).toEqual(fixedTimestamp);
  });

  it('should have deterministic `Date` constructor when called without arguments', () => {
    const fixedTimestamp = 1234567890000;
    const { context } = createContext({ seed, fixedTimestamp });

    const result1 = vm.runInContext('new Date().getTime()', context);
    const result2 = vm.runInContext('new Date().getTime()', context);

    expect(result1).toEqual(fixedTimestamp);
    expect(result2).toEqual(fixedTimestamp);
  });

  it('should preserve `Date` constructor behavior with arguments', () => {
    const { context } = createContext({ seed, fixedTimestamp });
    const specificTime = 946684800000; // Y2K

    const result = vm.runInContext(
      `new Date(${specificTime}).getTime()`,
      context
    );
    expect(result).toEqual(specificTime);
  });

  it('should have deterministic `crypto.getRandomValues()`', () => {
    const { context } = createContext({ seed, fixedTimestamp });

    const result1 = vm.runInContext(
      'crypto.getRandomValues(new Uint8Array(4))',
      context
    );
    const result2 = vm.runInContext(
      'crypto.getRandomValues(new Uint8Array(4))',
      context
    );

    // Results should be arrays with same seed-based values
    expect(Array.from(result1 as Uint8Array)).toEqual([116, 46, 96, 94]);
    expect(Array.from(result2 as Uint8Array)).toEqual([95, 100, 80, 41]);
  });

  it('should have deterministic `crypto.randomUUID()`', () => {
    const { context } = createContext({ seed, fixedTimestamp });

    const uuid1 = vm.runInContext('crypto.randomUUID()', context);
    const uuid2 = vm.runInContext('crypto.randomUUID()', context);

    expect(uuid1).toBeTypeOf('string');
    expect(uuid2).toBeTypeOf('string');
    expect(uuid1).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(uuid2).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(uuid1).not.toEqual(uuid2); // Should be different UUIDs
  });

  it('should maintain consistency across different context instances with same seed', () => {
    const { context: context1 } = createContext({
      seed,
      fixedTimestamp: 1000000000000,
    });
    const { context: context2 } = createContext({
      seed,
      fixedTimestamp: 1000000000000,
    });

    expect(vm.runInContext('Math.random()', context1)).toEqual(
      vm.runInContext('Math.random()', context2)
    );
    expect(vm.runInContext('Date.now()', context1)).toEqual(
      vm.runInContext('Date.now()', context2)
    );
  });

  it('should return workflow function that can be invoked', async () => {
    async function workflow(w: string) {
      return `hello,${w},${Math.random()},${Date.now()},${crypto.randomUUID()}`;
    }
    const { context } = createContext({ seed, fixedTimestamp });
    const workflowFn = vm.runInContext(`${workflow};workflow`, context);
    expect(workflowFn).toBeTypeOf('function');
    expect(workflowFn).toBeInstanceOf(vm.runInContext('Function', context));
    expect(await workflowFn('world')).toEqual(
      'hello,world,0.45558666071890863,1234567890000,26556528-6a20-4017-bbc9-a891206c6f69'
    );
  });

  it('should allow setting a Symbol on the globalThis object', async () => {
    const { context } = createContext({ seed, fixedTimestamp });
    const symbol = Symbol('foo');

    // @ts-expect-error - `@types/node` says symbol is not valid, but it does work
    context[symbol] = 'bar';

    // Find the symbol with description 'foo' (not the first one, since STABLE_ULID is also set)
    const fooValue = vm.runInContext(
      `const s = Object.getOwnPropertySymbols(globalThis).find(sym => sym.description === 'foo'); globalThis[s]`,
      context
    );
    expect(fooValue).toEqual('bar');
  });

  it('should allow setting a Symbol.for on the globalThis object', async () => {
    const { context } = createContext({ seed, fixedTimestamp });
    const symbol = Symbol.for('foo');

    // @ts-expect-error - `@types/node` says symbol is not valid, but it does work
    context[symbol] = 'bar';

    const fooValue = vm.runInContext(`globalThis[Symbol.for('foo')]`, context);
    expect(fooValue).toEqual('bar');
  });

  it('should have functional `crypto.subtle.digest()`', async () => {
    const { context } = createContext({ seed, fixedTimestamp });

    const promise = vm.runInContext(
      'crypto.subtle.digest("SHA-256", new TextEncoder().encode("hello"))',
      context
    );
    const result = await promise;
    expect(Buffer.from(result).toString('hex')).toEqual(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
    );
  });

  it('should throw an error for `crypto.subtle.generateKey()`', async () => {
    let err: Error | undefined;
    const { context } = createContext({ seed, fixedTimestamp });

    try {
      vm.runInContext(
        'crypto.subtle.generateKey({name: "RSA-OAEP",modulusLength: 4096,publicExponent: new Uint8Array([1, 0, 1]),hash: "SHA-256",},true,["encrypt", "decrypt"],)',
        context
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toEqual('Not implemented');
  });

  it('should call `onWorkflowError` when a workflow error occurs', async () => {
    const { context } = createContext({ seed, fixedTimestamp });

    const createUseStep =
      (ctx: { onWorkflowError: (err: Error) => void }) => () => () =>
        new Promise(() => {
          setTimeout(() => {
            ctx.onWorkflowError(new Error('workflow error'));
          }, 100);
        });

    let workflowErrorResolve: (err: Error) => void;
    const workflowErrorDeferred = new Promise<Error>((resolve) => {
      workflowErrorResolve = resolve;
    });

    function onWorkflowError(err: Error) {
      workflowErrorResolve?.(err);
    }

    context.useStep = createUseStep({
      onWorkflowError,
    });

    const workflowFn = await vm.runInContext(
      `
      const add = useStep('add');

      async function workflow() {
        await add(1, 2);
        return 'should not be returned';
      }

      workflow;
    `,
      context
    );
    expect(workflowFn).toBeTypeOf('function');

    const result = await Promise.race([workflowFn(), workflowErrorDeferred]);
    expect(result.message).toEqual('workflow error');
  });

  it('should allow updating the fixed timestamp', async () => {
    const { context, updateTimestamp } = createContext({
      seed,
      fixedTimestamp,
    });
    expect(vm.runInContext('Date.now()', context)).toEqual(fixedTimestamp);
    updateTimestamp(1234567890009);
    expect(vm.runInContext('Date.now()', context)).toEqual(1234567890009);
  });
});
