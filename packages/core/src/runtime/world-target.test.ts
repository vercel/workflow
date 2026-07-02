import { afterEach, describe, expect, it } from 'vitest';
import { createWorld } from './world-target.js';

describe('world-target default', () => {
  const originalTargetWorld = process.env.WORKFLOW_TARGET_WORLD;

  afterEach(() => {
    if (originalTargetWorld === undefined) {
      delete process.env.WORKFLOW_TARGET_WORLD;
    } else {
      process.env.WORKFLOW_TARGET_WORLD = originalTargetWorld;
    }
  });

  it('throws when no target world was statically injected', () => {
    delete process.env.WORKFLOW_TARGET_WORLD;

    expect(() => createWorld()).toThrow(/not statically injected/);
  });

  it('throws when the local target world was not statically injected', () => {
    process.env.WORKFLOW_TARGET_WORLD = 'local';

    expect(() => createWorld()).toThrow(/not statically injected/);
  });

  it('throws when a non-local target was not statically injected', () => {
    process.env.WORKFLOW_TARGET_WORLD = '@workflow/world-postgres';

    expect(() => createWorld()).toThrow(/not statically injected/);
  });
});
