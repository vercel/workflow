import { afterEach, describe, expect, test } from 'vitest';
import { getDeploymentUrl, hasStepSourceMaps } from './utils';

const ORIGINAL_ENV = { ...process.env };

function setStepSourceMapEnv({
  appName,
  dev,
}: {
  appName: string;
  dev: boolean;
}) {
  process.env.APP_NAME = appName;
  process.env.DEPLOYMENT_URL = 'http://localhost:3000';

  if (dev) {
    process.env.DEV_TEST_CONFIG = '{}';
  } else {
    delete process.env.DEV_TEST_CONFIG;
  }
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('hasStepSourceMaps', () => {
  test('expects source filenames for webpack local dev', () => {
    setStepSourceMapEnv({
      appName: 'nextjs-webpack',
      dev: true,
    });

    expect(hasStepSourceMaps()).toBe(true);
  });

  test('does not expect source filenames for turbopack local dev', () => {
    setStepSourceMapEnv({
      appName: 'nextjs-turbopack',
      dev: true,
    });

    expect(hasStepSourceMaps()).toBe(false);
  });

  test('does not expect source filenames for webpack local production builds', () => {
    setStepSourceMapEnv({
      appName: 'nextjs-webpack',
      dev: false,
    });

    expect(hasStepSourceMaps()).toBe(false);
  });

  test('expects source filenames for a framework in local dev', () => {
    setStepSourceMapEnv({ appName: 'express', dev: true });

    expect(hasStepSourceMaps()).toBe(true);
  });

  test('does not expect source filenames for a framework in local production', () => {
    setStepSourceMapEnv({ appName: 'express', dev: false });

    expect(hasStepSourceMaps()).toBe(false);
  });

  test('does not expect source filenames for nest, even in local dev', () => {
    // The Nest integration does not signal a dev build, so source maps default
    // to off (dev-on/prod-off) in both dev and prod.
    setStepSourceMapEnv({ appName: 'nest', dev: true });
    expect(hasStepSourceMaps()).toBe(false);

    setStepSourceMapEnv({ appName: 'nest', dev: false });
    expect(hasStepSourceMaps()).toBe(false);
  });
});

describe('getDeploymentUrl', () => {
  test('keeps deployment URLs unchanged without WORKFLOW_E2E_BASE_PATH', () => {
    process.env.DEPLOYMENT_URL = 'http://localhost:3000';
    delete process.env.WORKFLOW_E2E_BASE_PATH;

    expect(getDeploymentUrl()).toBe('http://localhost:3000');
  });

  test('appends WORKFLOW_E2E_BASE_PATH once', () => {
    process.env.DEPLOYMENT_URL = 'http://localhost:3000';
    process.env.WORKFLOW_E2E_BASE_PATH = '/app/';

    expect(getDeploymentUrl()).toBe('http://localhost:3000/app');

    process.env.DEPLOYMENT_URL = 'http://localhost:3000/app';
    expect(getDeploymentUrl()).toBe('http://localhost:3000/app');
  });
});
