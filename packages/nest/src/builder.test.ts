import type { WorkflowConfig } from '@workflow/builders';
import { afterEach, describe, expect, test } from 'vitest';
import { NestLocalBuilder } from './builder.js';

const originalTargetWorld = process.env.WORKFLOW_TARGET_WORLD;

const getBuilderConfig = (builder: NestLocalBuilder) =>
  (builder as unknown as { config: WorkflowConfig }).config;

describe('NestLocalBuilder', () => {
  afterEach(() => {
    if (originalTargetWorld === undefined) {
      delete process.env.WORKFLOW_TARGET_WORLD;
    } else {
      process.env.WORKFLOW_TARGET_WORLD = originalTargetWorld;
    }
  });

  test('bundles the default local world package', () => {
    delete process.env.WORKFLOW_TARGET_WORLD;

    const builder = new NestLocalBuilder();

    expect(getBuilderConfig(builder).externalPackages).not.toContain(
      '@workflow/world-local'
    );
  });

  test('externalizes a non-local statically configured world package', () => {
    process.env.WORKFLOW_TARGET_WORLD = '@workflow/world-postgres';

    const builder = new NestLocalBuilder();

    expect(getBuilderConfig(builder).externalPackages).toContain(
      '@workflow/world-postgres'
    );
  });

  test('bundles relative target world modules', () => {
    process.env.WORKFLOW_TARGET_WORLD = './my-world.ts';

    const builder = new NestLocalBuilder();

    expect(getBuilderConfig(builder).externalPackages).not.toContain(
      './my-world.ts'
    );
  });
});
