import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `withWorkflow()` takes the app's `NextConfig`, and that type is nominally
 * per-copy: the app's config is typed by the `next` in the app's
 * dependencies, while the parameter in this package's emitted `.d.ts` is
 * typed by the `next` in these devDependencies. `NextConfig` reaches
 * `NextConfigComplete` through the `webpack` hook's context argument, and
 * `NextConfigComplete` is `Required<Omit<NextConfig, …>>`, so every option
 * a Next.js minor adds becomes a required property. 16.3 added five
 * (`agentRules`, `instrumentationClientInject`, `outputHashSalt`,
 * `partialPrefetching`, `supportsImmutableAssets`), which is enough to make
 * the two `NextConfig`s stop being assignable to one another.
 *
 * The app is then the one that fails: `next build` reports "Failed to type
 * check" on its own `next.config.ts`, with nothing in the app changed. So
 * this package has to move in lockstep with the apps that wrap their config
 * with it.
 */

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..');
const workbenchRoot = join(packageRoot, '../../workbench');

const NEXT_CONFIG_FILENAMES = [
  'next.config.ts',
  'next.config.mts',
  'next.config.mjs',
  'next.config.js',
  'next.config.cjs',
];

interface Manifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readManifest(path: string): Manifest {
  return JSON.parse(readFileSync(path, 'utf8')) as Manifest;
}

/**
 * Workbench apps that both depend on `next` and route their config through
 * `withWorkflow()`. An app that only happens to use Next.js — the SWC
 * playground, say — carries none of the type coupling and is left alone.
 */
function findWorkflowNextApps(): { name: string; next: string }[] {
  const apps: { name: string; next: string }[] = [];

  for (const entry of readdirSync(workbenchRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const appDir = join(workbenchRoot, entry.name);
    const manifestPath = join(appDir, 'package.json');
    if (!existsSync(manifestPath)) {
      continue;
    }

    const manifest = readManifest(manifestPath);
    const next = manifest.dependencies?.next ?? manifest.devDependencies?.next;
    if (!next) {
      continue;
    }

    const configPath = NEXT_CONFIG_FILENAMES.map((filename) =>
      join(appDir, filename)
    ).find(existsSync);
    // Matches both `workflow/next` and `@workflow/next`.
    if (
      !configPath ||
      !readFileSync(configPath, 'utf8').includes('workflow/next')
    ) {
      continue;
    }

    apps.push({ name: entry.name, next });
  }

  return apps;
}

describe('next devDependency', () => {
  const pluginNext = readManifest(join(packageRoot, 'package.json'))
    .devDependencies?.next;

  it('is pinned to an exact version', () => {
    expect(pluginNext).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('matches every workbench app that wraps its config with withWorkflow', () => {
    const apps = findWorkflowNextApps();

    // A discovery bug would otherwise pass this as an empty comparison.
    expect(apps.length).toBeGreaterThan(0);

    expect(
      Object.fromEntries(apps.map(({ name, next }) => [name, next]))
    ).toEqual(Object.fromEntries(apps.map(({ name }) => [name, pluginNext])));
  });
});
