import { afterEach, describe, expect, test } from 'vitest';
import { hasStepSourceMaps } from './utils';

const ORIGINAL_ENV = { ...process.env };

function setStepSourceMapEnv({
  appName,
  dev,
  lazyDiscovery,
}: {
  appName: string;
  dev: boolean;
  lazyDiscovery?: boolean;
}) {
  process.env.APP_NAME = appName;
  process.env.DEPLOYMENT_URL = 'http://localhost:3000';

  if (dev) {
    process.env.DEV_TEST_CONFIG = '{}';
  } else {
    delete process.env.DEV_TEST_CONFIG;
  }

  if (lazyDiscovery === undefined) {
    delete process.env.WORKFLOW_NEXT_LAZY_DISCOVERY;
  } else {
    process.env.WORKFLOW_NEXT_LAZY_DISCOVERY = lazyDiscovery ? '1' : '0';
  }
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('hasStepSourceMaps', () => {
  test('expects source filenames for webpack local dev with lazy discovery enabled', () => {
    setStepSourceMapEnv({
      appName: 'nextjs-webpack',
      dev: true,
      lazyDiscovery: true,
    });

    expect(hasStepSourceMaps()).toBe(true);
  });

  test('expects source filenames for webpack local dev with lazy discovery disabled', () => {
    setStepSourceMapEnv({
      appName: 'nextjs-webpack',
      dev: true,
      lazyDiscovery: false,
    });

    expect(hasStepSourceMaps()).toBe(true);
  });

  test('does not expect source filenames for turbopack local dev with lazy discovery disabled', () => {
    setStepSourceMapEnv({
      appName: 'nextjs-turbopack',
      dev: true,
      lazyDiscovery: false,
    });

    expect(hasStepSourceMaps()).toBe(false);
  });

  test('does not expect source filenames for turbopack local dev with lazy discovery enabled', () => {
    setStepSourceMapEnv({
      appName: 'nextjs-turbopack',
      dev: true,
      lazyDiscovery: true,
    });

    expect(hasStepSourceMaps()).toBe(false);
  });

  test('does not expect source filenames for webpack local production builds', () => {
    setStepSourceMapEnv({
      appName: 'nextjs-webpack',
      dev: false,
      lazyDiscovery: false,
    });

    expect(hasStepSourceMaps()).toBe(false);
  });
});
