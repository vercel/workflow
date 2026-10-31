import { describe, expect, it } from 'vitest';
import {
  joinWorkflowBasePath,
  normalizeWorkflowRoutePrefix,
  workflowRoutePrefixDirectory,
} from './route-prefix.js';

describe('normalizeWorkflowRoutePrefix', () => {
  it.each([
    ['/ship', '/ship'],
    ['ship', '/ship'],
    ['/ship/', '/ship'],
    ['  /ship  ', '/ship'],
    ['/ship/flows', '/ship/flows'],
    ['ship/flows/', '/ship/flows'],
    ['/app-v1.2_~x', '/app-v1.2_~x'],
  ])('normalizes %o to %o', (input, expected) => {
    expect(normalizeWorkflowRoutePrefix(input)).toBe(expected);
  });

  it.each([undefined, '', '   ', '/'])('treats %o as no prefix', (input) => {
    expect(normalizeWorkflowRoutePrefix(input)).toBeUndefined();
  });

  it.each([
    ['https://example.com/ship'],
    // No scheme, so a `://` test alone would read the host as a path segment.
    ['//example.com/ship'],
    ['/ship?x=1'],
    ['/ship#top'],
    ['\\ship'],
    ['/ship//flows'],
    ['/../ship'],
    ['/./ship'],
    ['/[team]'],
    ['/(group)'],
    ['/@slot'],
    ['/my ship'],
    ['/ship%2Fflows'],
    // Next.js excludes `_`-prefixed folders from routing, so these would build
    // and then 404.
    ['/_ship'],
    ['/ship/_flows'],
  ])('rejects %o', (input) => {
    expect(() => normalizeWorkflowRoutePrefix(input)).toThrowError(
      /workflows\.experimentalRoutePrefix/
    );
  });

  it('allows an underscore inside a segment', () => {
    expect(normalizeWorkflowRoutePrefix('/my_ship')).toBe('/my_ship');
  });
});

describe('workflowRoutePrefixDirectory', () => {
  it('drops the leading slash so the prefix can be joined onto a directory', () => {
    expect(workflowRoutePrefixDirectory('/ship')).toBe('ship');
    expect(workflowRoutePrefixDirectory('/ship/flows')).toBe('ship/flows');
  });

  // `path.join` drops the empty fragment, so unprefixed layouts keep their
  // exact paths. `null` is reachable from an untyped `next.config.js`.
  it.each([undefined, null, ''])('is empty for %o', (prefix) => {
    expect(workflowRoutePrefixDirectory(prefix as string | undefined)).toBe('');
  });
});

describe('joinWorkflowBasePath', () => {
  it('appends the route prefix to the Next.js basePath', () => {
    expect(joinWorkflowBasePath('/base', '/ship')).toBe('/base/ship');
  });

  it('uses either half on its own', () => {
    expect(joinWorkflowBasePath('/base', undefined)).toBe('/base');
    expect(joinWorkflowBasePath(undefined, '/ship')).toBe('/ship');
  });

  // Generated route files omit the `basePath` option entirely when it is
  // undefined, so this keeps their output byte-identical for apps that use
  // neither option.
  it('stays undefined when neither is configured', () => {
    expect(joinWorkflowBasePath(undefined, undefined)).toBeUndefined();
  });
});
