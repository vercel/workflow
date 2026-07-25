import type { World } from '@workflow/world';
import { describe, expect, it } from 'vitest';
import { createWorldFromModule, type WorldFactoryModule } from './world.js';

type LegacyWorldFactoryModule = {
  createLocalWorld?: () => World;
  createVercelWorld?: () => World;
};

describe('createWorldFromModule', () => {
  it('uses the canonical createWorld factory export', () => {
    const world = {} as World;

    expect(createWorldFromModule({ createWorld: () => world })).toBe(world);
  });

  it('rejects obsolete world-specific factory exports', () => {
    const legacyFactoryModules: LegacyWorldFactoryModule[] = [
      { createLocalWorld: () => ({}) as World },
      { createVercelWorld: () => ({}) as World },
    ];

    for (const legacyFactoryModule of legacyFactoryModules) {
      // Dynamic imports are untyped at runtime, so model an older JavaScript
      // module crossing the current factory contract.
      expect(() =>
        createWorldFromModule(
          legacyFactoryModule as unknown as WorldFactoryModule
        )
      ).toThrow(/must export createWorld/);
    }
  });
});
