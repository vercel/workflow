import { describe, expect, it } from 'vitest';
import {
  basePathReachesRoutes,
  normalizeBasePath,
  resolveModuleOptions,
  servedGlobalPrefix,
  workflowRoutesExcludedFromGlobalPrefix,
} from './options.js';

describe('basePathReachesRoutes', () => {
  it.each([
    // [generating, globalPrefix, reachable]
    ['', '', true],
    ['/api', '/api', true],
    // No global prefix: any generated prefix is a sub-path applied outside
    // NestJS (a reverse proxy that strips it), which is a valid deployment.
    ['/proxied', '', true],
    // Proxy sub-path composed in front of the NestJS prefix.
    ['/proxied/api', '/api', true],
    // NestJS serves under /api but the generated URL never reaches it.
    ['', '/api', false],
    ['/other', '/api', false],
    ['/api/v2', '/api', false],
    // The suffix test lands on a segment boundary for free, because a
    // normalized prefix always starts with "/": "/myapi" does not end with
    // "/api", so a prefix that is only a substring is still rejected.
    ['/myapi', '/api', false],
    ['/my/api', '/api', true],
  ])('%o against prefix %o is reachable: %o', (generating, prefix, expected) => {
    expect(basePathReachesRoutes(generating, prefix)).toBe(expected);
  });
});

describe('normalizeBasePath', () => {
  it.each([
    [undefined, ''],
    ['', ''],
    ['/', ''],
    ['api', '/api'],
    ['/api', '/api'],
    ['/api/', '/api'],
    ['/api///', '/api'],
    ['  /api  ', '/api'],
    ['/api/v2', '/api/v2'],
  ])('normalizes %o to %o', (input, expected) => {
    expect(normalizeBasePath(input)).toBe(expected);
  });
});

describe('resolveModuleOptions', () => {
  it('defaults skipBuild to true on Vercel', () => {
    // The Build Output already contains the bundles and the filesystem is
    // read-only, so an in-process build there can only fail.
    expect(resolveModuleOptions({}, { VERCEL: '1' }).skipBuild).toBe(true);
  });

  it('defaults skipBuild to false off Vercel', () => {
    expect(resolveModuleOptions({}, {}).skipBuild).toBe(false);
  });

  it('lets an explicit skipBuild win over the Vercel default', () => {
    expect(
      resolveModuleOptions({ skipBuild: false }, { VERCEL: '1' }).skipBuild
    ).toBe(false);
  });

  it('pins watch off because the builder discards its esbuild contexts', () => {
    expect(resolveModuleOptions({ watch: true }, {}).watch).toBe(false);
  });

  it('normalizes basePath', () => {
    expect(resolveModuleOptions({ basePath: 'api/' }, {}).basePath).toBe(
      '/api'
    );
  });

  it('resolves outDir under workingDir when not given', () => {
    expect(resolveModuleOptions({ workingDir: '/app' }, {}).outDir).toBe(
      '/app/.nestjs/workflow'
    );
  });

  it('keeps an explicit outDir', () => {
    expect(
      resolveModuleOptions({ workingDir: '/app', outDir: '/tmp/bundles' }, {})
        .outDir
    ).toBe('/tmp/bundles');
  });

  it('defaults preloadBundles on and world management off', () => {
    const resolved = resolveModuleOptions({}, {});
    expect(resolved.preloadBundles).toBe(true);
    expect(resolved.manageWorldLifecycle).toBe(false);
  });

  it('defaults preloadBundles off on Vercel', () => {
    expect(resolveModuleOptions({}, { VERCEL: '1' }).preloadBundles).toBe(
      false
    );
  });

  it('defaults the body-parser bypass on', () => {
    expect(resolveModuleOptions({}, {}).bypassBodyParser).toBe(true);
    expect(
      resolveModuleOptions({ bypassBodyParser: false }, {}).bypassBodyParser
    ).toBe(false);
  });
});

/** The shape NestJS stores after normalizing `setGlobalPrefix`'s `exclude`. */
function excluded(pattern: RegExp, requestMethod = 5) {
  return { path: pattern.source, requestMethod, pathRegex: pattern };
}

describe('workflowRoutesExcludedFromGlobalPrefix', () => {
  it('is false without any exclusions', () => {
    expect(workflowRoutesExcludedFromGlobalPrefix(undefined)).toBe(false);
    expect(workflowRoutesExcludedFromGlobalPrefix({})).toBe(false);
    expect(workflowRoutesExcludedFromGlobalPrefix({ exclude: [] })).toBe(false);
  });

  it('detects a normalized all-method exclusion of the flow route', () => {
    expect(
      workflowRoutesExcludedFromGlobalPrefix({
        exclude: [excluded(/^\/\.well-known\/workflow\/v1\/(.*)$/)],
      })
    ).toBe(true);
  });

  it('ignores an exclusion for another path', () => {
    expect(
      workflowRoutesExcludedFromGlobalPrefix({
        exclude: [excluded(/^\/health$/)],
      })
    ).toBe(false);
  });

  it('ignores a method-scoped exclusion', () => {
    // Only some methods would move, and no single generated base path can
    // address both halves, so the prefix is still the honest answer.
    const GET = 0;
    expect(
      workflowRoutesExcludedFromGlobalPrefix({
        exclude: [excluded(/^\/\.well-known\/workflow\/v1\/(.*)$/, GET)],
      })
    ).toBe(false);
  });

  it('accepts a raw string exclusion', () => {
    expect(
      workflowRoutesExcludedFromGlobalPrefix({
        exclude: ['/.well-known/workflow/v1/flow'],
      })
    ).toBe(true);
  });
});

describe('servedGlobalPrefix', () => {
  it('is empty without a prefix', () => {
    expect(servedGlobalPrefix(undefined)).toBe('');
    expect(servedGlobalPrefix({ getGlobalPrefix: () => '' })).toBe('');
  });

  it('normalizes the configured prefix', () => {
    expect(servedGlobalPrefix({ getGlobalPrefix: () => 'api/' })).toBe('/api');
  });

  it('is empty when the workflow routes are excluded from the prefix', () => {
    expect(
      servedGlobalPrefix({
        getGlobalPrefix: () => 'api',
        getGlobalPrefixOptions: () => ({
          exclude: [excluded(/^\/\.well-known\/workflow\/v1\/(.*)$/)],
        }),
      })
    ).toBe('');
  });
});
