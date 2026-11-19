import { describe, expect, it } from 'vitest';
import {
  joinWorkflowBasePath,
  normalizeWorkflowRoutePrefix,
  workflowRoutePrefixDirectory,
} from './route-prefix.js';

describe('normalizeWorkflowRoutePrefix', () => {
  it.each([
    ['/dashboard', '/dashboard'],
    ['dashboard', '/dashboard'],
    ['/dashboard/', '/dashboard'],
    ['  /dashboard  ', '/dashboard'],
    ['/dashboard/flows', '/dashboard/flows'],
    ['dashboard/flows/', '/dashboard/flows'],
    ['/app-v1.2_~x', '/app-v1.2_~x'],
  ])('normalizes %o to %o', (input, expected) => {
    expect(normalizeWorkflowRoutePrefix(input)).toBe(expected);
  });

  it.each([undefined, '', '   ', '/'])('treats %o as no prefix', (input) => {
    expect(normalizeWorkflowRoutePrefix(input)).toBeUndefined();
  });

  it.each([
    ['https://example.com/dashboard'],
    // No scheme, so a `://` test alone would read the host as a path segment.
    ['//example.com/dashboard'],
    ['/dashboard?x=1'],
    ['/dashboard#top'],
    ['\\dashboard'],
    ['/dashboard//flows'],
    ['/../dashboard'],
    ['/./dashboard'],
    ['/[team]'],
    ['/(group)'],
    ['/@slot'],
    ['/my dashboard'],
    ['/dashboard%2Fflows'],
    // Next.js excludes `_`-prefixed folders from routing, so these would build
    // and then 404.
    ['/_dashboard'],
    ['/dashboard/_flows'],
    // The stale-route sweep never descends into dot directories, so routes
    // below one would outlive a later prefix change.
    ['/.internal'],
    ['/.well-known/dashboard'],
    ['/dashboard/.hidden'],
  ])('rejects %o', (input) => {
    expect(() => normalizeWorkflowRoutePrefix(input)).toThrowError(
      /workflows\.experimentalRoutePrefix/
    );
  });

  it('allows an underscore inside a segment', () => {
    expect(normalizeWorkflowRoutePrefix('/my_dashboard')).toBe('/my_dashboard');
  });

  it('allows a dot inside a segment', () => {
    expect(normalizeWorkflowRoutePrefix('/dashboard.v1')).toBe('/dashboard.v1');
  });
});

describe('workflowRoutePrefixDirectory', () => {
  it('drops the leading slash so the prefix can be joined onto a directory', () => {
    expect(workflowRoutePrefixDirectory('/dashboard')).toBe('dashboard');
    expect(workflowRoutePrefixDirectory('/dashboard/flows')).toBe(
      'dashboard/flows'
    );
  });

  // `path.join` drops the empty fragment, so unprefixed layouts keep their
  // exact paths. `null` is reachable from an untyped `next.config.js`.
  it.each([undefined, null, ''])('is empty for %o', (prefix) => {
    expect(workflowRoutePrefixDirectory(prefix as string | undefined)).toBe('');
  });
});

describe('joinWorkflowBasePath', () => {
  it('appends the route prefix to the Next.js basePath', () => {
    expect(joinWorkflowBasePath('/base', '/dashboard')).toBe('/base/dashboard');
  });

  it('uses either half on its own', () => {
    expect(joinWorkflowBasePath('/base', undefined)).toBe('/base');
    expect(joinWorkflowBasePath(undefined, '/dashboard')).toBe('/dashboard');
  });

  // Generated route files omit the `basePath` option entirely when it is
  // undefined, so this keeps their output byte-identical for apps that use
  // neither option.
  it('stays undefined when neither is configured', () => {
    expect(joinWorkflowBasePath(undefined, undefined)).toBeUndefined();
  });
});
