import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  checkWorkflowVersionSkew,
  collectWorkflowVersions,
  describeVersionSkew,
  resolvePackageFrom,
  VERSION_CHECK_ENV_VAR,
  type WorkflowVersions,
} from './version-check.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function versions(overrides: Partial<WorkflowVersions> = {}): WorkflowVersions {
  return {
    appCore: {
      name: '@workflow/core',
      version: '5.0.0-beta.53',
      dir: '/app/node_modules/@workflow/core',
    },
    appSdk: {
      name: 'workflow',
      version: '5.0.0-beta.53',
      dir: '/app/node_modules/workflow',
    },
    harnessCore: {
      name: '@workflow/core',
      version: '5.0.0-beta.53',
      dir: '/app/node_modules/@workflow/vitest/node_modules/@workflow/core',
    },
    vitest: {
      name: '@workflow/vitest',
      version: '5.0.0-beta.53',
      dir: '/app/node_modules/@workflow/vitest',
    },
    ...overrides,
  };
}

describe('resolvePackageFrom', () => {
  it('resolves a package to its version and directory', () => {
    // `vitest` is a devDependency of this package and its exports map does not
    // publish ./package.json, which is the case the resolver has to handle.
    const resolved = resolvePackageFrom('vitest', packageRoot);

    expect(resolved?.name).toBe('vitest');
    expect(resolved?.version).toMatch(/^\d+\./);
    expect(resolved?.dir).toContain('vitest');
  });

  it('returns undefined for a package that is not installed', () => {
    expect(
      resolvePackageFrom('@workflow/not-a-real-package', packageRoot)
    ).toBeUndefined();
  });
});

describe('describeVersionSkew', () => {
  it('says nothing when both sides load the same copy', () => {
    const same = {
      name: '@workflow/core',
      version: '5.0.0-beta.53',
      dir: '/app/node_modules/@workflow/core',
    };
    expect(
      describeVersionSkew(versions({ appCore: same, harnessCore: same }))
    ).toBeUndefined();
  });

  it('says nothing when two copies agree on the version', () => {
    expect(describeVersionSkew(versions())).toBeUndefined();
  });

  it('says nothing when either side cannot be resolved', () => {
    expect(
      describeVersionSkew(versions({ appCore: undefined }))
    ).toBeUndefined();
    expect(
      describeVersionSkew(versions({ harnessCore: undefined }))
    ).toBeUndefined();
  });

  it('fails a v4 app running against the v5 harness, and says what to install', () => {
    const report = describeVersionSkew(
      versions({
        appCore: {
          name: '@workflow/core',
          version: '4.8.9',
          dir: '/app/node_modules/@workflow/core',
        },
        appSdk: {
          name: 'workflow',
          version: '4.8.9',
          dir: '/app/node_modules/workflow',
        },
      })
    );

    expect(report?.severity).toBe('error');
    expect(report?.message).toContain('Incompatible Workflow SDK versions');
    expect(report?.message).toContain('@workflow/core 4.8.9 (via workflow');
    expect(report?.message).toContain(
      '@workflow/core 5.0.0-beta.53 (via @workflow/vitest 5.0.0-beta.53)'
    );
    // A v4 app belongs on the `latest` tag, not on the beta.
    expect(report?.message).toContain('npm i -D @workflow/vitest@latest');
    expect(report?.message).toContain(`${VERSION_CHECK_ENV_VAR}=off`);
  });

  it('points a v5 app at the beta tag', () => {
    const report = describeVersionSkew(
      versions({
        harnessCore: {
          name: '@workflow/core',
          version: '4.8.9',
          dir: '/app/node_modules/@workflow/vitest/node_modules/@workflow/core',
        },
        vitest: {
          name: '@workflow/vitest',
          version: '4.0.25',
          dir: '/app/node_modules/@workflow/vitest',
        },
      })
    );

    expect(report?.severity).toBe('error');
    expect(report?.message).toContain('npm i -D @workflow/vitest@beta');
  });

  it('warns, rather than fails, on two versions within one major', () => {
    const report = describeVersionSkew(
      versions({
        harnessCore: {
          name: '@workflow/core',
          version: '5.0.0-beta.40',
          dir: '/app/node_modules/@workflow/vitest/node_modules/@workflow/core',
        },
      })
    );

    expect(report?.severity).toBe('warning');
    expect(report?.message).toContain('Workflow SDK version mismatch');
    expect(report?.message).toContain('two different copies of @workflow/core');
  });

  it('fails open when a version cannot be parsed', () => {
    const report = describeVersionSkew(
      versions({
        harnessCore: {
          name: '@workflow/core',
          version: 'workspace:*',
          dir: '/app/node_modules/@workflow/vitest/node_modules/@workflow/core',
        },
      })
    );

    expect(report?.severity).toBe('warning');
  });
});

describe('checkWorkflowVersionSkew', () => {
  const skewed = () =>
    versions({
      appCore: {
        name: '@workflow/core',
        version: '4.8.9',
        dir: '/app/node_modules/@workflow/core',
      },
    });

  it('throws on an incompatible pair', () => {
    expect(() =>
      checkWorkflowVersionSkew({ cwd: '/app', env: {}, collect: skewed })
    ).toThrow(/Incompatible Workflow SDK versions/);
  });

  it('warns without throwing on a same-major mismatch', () => {
    const warn = vi.fn();
    const report = checkWorkflowVersionSkew({
      cwd: '/app',
      env: {},
      warn,
      collect: () =>
        versions({
          harnessCore: {
            name: '@workflow/core',
            version: '5.0.0-beta.40',
            dir: '/app/node_modules/@workflow/vitest/node_modules/@workflow/core',
          },
        }),
    });

    expect(report?.severity).toBe('warning');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('Workflow SDK version mismatch');
  });

  it('can be turned off', () => {
    for (const value of ['off', '0', 'false', 'OFF']) {
      expect(
        checkWorkflowVersionSkew({
          cwd: '/app',
          env: { [VERSION_CHECK_ENV_VAR]: value },
          collect: skewed,
        })
      ).toBeUndefined();
    }
  });

  it('is quiet for this workspace, where every package is the same copy', () => {
    const warn = vi.fn();
    expect(
      checkWorkflowVersionSkew({ cwd: packageRoot, env: {}, warn })
    ).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();

    const resolved = collectWorkflowVersions(packageRoot);
    expect(resolved.harnessCore?.version).toBe(resolved.vitest?.version);
  });
});
