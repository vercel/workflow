import { afterEach, describe, expect, test } from 'vitest';
import {
  globalSingleton,
  resetGlobalSingletonForTest,
} from './global-singleton';

const NAME = '@workflow/utils//globalSingletonTest';

afterEach(() => {
  for (const version of [1, 2]) {
    resetGlobalSingletonForTest(NAME, version);
  }
});

describe('globalSingleton', () => {
  test('returns the same object for repeated calls', () => {
    const first = globalSingleton(NAME, 1, () => ({ calls: 0 }));
    const second = globalSingleton(NAME, 1, () => ({ calls: 0 }));

    expect(second).toBe(first);
  });

  test('runs the factory exactly once', () => {
    let factoryRuns = 0;
    const create = () => {
      factoryRuns++;
      return { value: factoryRuns };
    };

    globalSingleton(NAME, 1, create);
    globalSingleton(NAME, 1, create);
    globalSingleton(NAME, 1, create);

    expect(factoryRuns).toBe(1);
  });

  test('mutations are visible to every holder', () => {
    // The point of the helper: two module copies each call globalSingleton and
    // then write through their own reference. A second `const` per copy — the
    // bug this replaces — would make these two objects independent.
    const copyA = globalSingleton(NAME, 1, () => ({
      transports: new Map<string, string>(),
    }));
    const copyB = globalSingleton(NAME, 1, () => ({
      transports: new Map<string, string>(),
    }));

    copyA.transports.set('run_1', 'ws');

    expect(copyB.transports.get('run_1')).toBe('ws');
  });

  test('reaches across module instances via globalThis, not module scope', () => {
    const created = globalSingleton(NAME, 1, () => ({ marker: 'shared' }));

    // A second copy of a bundled module has its own module scope but the same
    // realm, so the only thing it shares is the global. Read it the way that
    // copy would: off globalThis, by well-known symbol.
    const key = Symbol.for(`${NAME}/v1`);
    const fromGlobal = (globalThis as Record<symbol, unknown>)[key];

    expect(fromGlobal).toBe(created);
  });

  test('different shape versions do not share state', () => {
    const v1 = globalSingleton(NAME, 1, () => ({ shape: 'old' }));
    const v2 = globalSingleton(NAME, 2, () => ({ shape: 'new' }));

    expect(v2).not.toBe(v1);
    expect(v1.shape).toBe('old');
    expect(v2.shape).toBe('new');
  });

  test('different names do not share state', () => {
    const a = globalSingleton(`${NAME}/a`, 1, () => ({ which: 'a' }));
    const b = globalSingleton(`${NAME}/b`, 1, () => ({ which: 'b' }));

    expect(b).not.toBe(a);

    resetGlobalSingletonForTest(`${NAME}/a`, 1);
    resetGlobalSingletonForTest(`${NAME}/b`, 1);
  });
});

describe('resetGlobalSingletonForTest', () => {
  test('makes the next call build a fresh object', () => {
    const before = globalSingleton(NAME, 1, () => ({ id: 'first' }));

    resetGlobalSingletonForTest(NAME, 1);
    const after = globalSingleton(NAME, 1, () => ({ id: 'second' }));

    expect(after).not.toBe(before);
    expect(after.id).toBe('second');
  });

  test('only clears the version it names', () => {
    const v1 = globalSingleton(NAME, 1, () => ({ shape: 'old' }));
    const v2 = globalSingleton(NAME, 2, () => ({ shape: 'new' }));

    resetGlobalSingletonForTest(NAME, 1);

    expect(globalSingleton(NAME, 1, () => ({ shape: 'rebuilt' }))).not.toBe(v1);
    expect(globalSingleton(NAME, 2, () => ({ shape: 'unused' }))).toBe(v2);
  });

  test('is a no-op when nothing was created', () => {
    expect(() => resetGlobalSingletonForTest(NAME, 1)).not.toThrow();
  });
});
