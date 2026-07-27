import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorld, setWorld } from './world.js';

/**
 * Covers the diagnostics around resolving a custom (non-built-in) world named
 * by `WORKFLOW_TARGET_WORLD`. The world package is not a dependency of
 * `@workflow/core`, so it is resolved from the app at runtime — and when that
 * resolution fails, the raw error (`ERR_MODULE_NOT_FOUND`, or a bundler's
 * "expression is too dynamic" stub) says nothing about workflows or about the
 * `setWorld()` escape hatch.
 */
describe('custom world resolution', () => {
  const priorTargetWorld = process.env.WORKFLOW_TARGET_WORLD;

  beforeEach(() => {
    setWorld(undefined);
  });

  afterEach(() => {
    setWorld(undefined);
    if (priorTargetWorld === undefined) {
      delete process.env.WORKFLOW_TARGET_WORLD;
    } else {
      process.env.WORKFLOW_TARGET_WORLD = priorTargetWorld;
    }
  });

  it('loads a world module by absolute path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'workflow-world-'));
    const modulePath = join(dir, 'world.mjs');
    writeFileSync(
      modulePath,
      `export function createWorld() {
         return { specVersion: 'test-spec-version' };
       }\n`
    );

    process.env.WORKFLOW_TARGET_WORLD = modulePath;

    const world = await createWorld();
    expect(world.specVersion).toBe('test-spec-version');
  });

  it('explains how to register the world when the package cannot be resolved', async () => {
    process.env.WORKFLOW_TARGET_WORLD = '@workflow/world-that-is-not-installed';

    const error = await createWorld().then(
      () => undefined,
      (err: unknown) => err as Error
    );

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain('@workflow/world-that-is-not-installed');
    // The actionable part: the raw ERR_MODULE_NOT_FOUND doesn't mention any of
    // this, and following it is the only fix for self-contained bundles.
    expect(error?.message).toContain('setWorld');
    expect(error?.message).toContain('Resolution attempts:');
    // Both strategies are reported so the failure can be told apart from a
    // world module that resolved but exported the wrong shape.
    expect(error?.message).toContain('require(');
    expect(error?.message).toContain('import(');
    expect(error?.cause).toBeDefined();
  });

  it('calls out a bundler stub when the dynamic import was rewritten', async () => {
    // Simulates what webpack/Turbopack leave behind when the ignore comments
    // are lost: the import resolves to a module that throws their stub error.
    const dir = mkdtempSync(join(tmpdir(), 'workflow-world-'));
    const modulePath = join(dir, 'stubbed-world.mjs');
    writeFileSync(
      modulePath,
      "throw new Error('Cannot find module as expression is too dynamic');\n"
    );

    process.env.WORKFLOW_TARGET_WORLD = modulePath;

    const error = await createWorld().then(
      () => undefined,
      (err: unknown) => err as Error
    );

    expect(error?.message).toContain('replaced by a bundler stub');
    expect(error?.message).toContain('setWorld');
  });

  it('keeps the underlying failure as the error cause for invalid world modules', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'workflow-world-'));
    const modulePath = join(dir, 'not-a-world.mjs');
    writeFileSync(modulePath, 'export const notAFactory = 1;\n');

    process.env.WORKFLOW_TARGET_WORLD = modulePath;

    const error = await createWorld().then(
      () => undefined,
      (err: unknown) => err as Error
    );

    expect(error?.message).toContain('Invalid target world module');
    expect(error?.cause).toBeInstanceOf(Error);
  });
});
