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
    ['/ship?x=1'],
    ['/ship#top'],
    ['\\ship'],
    ['/ship//flows'],
    ['/../ship'],
    ['/./ship'],
    ['/[team]'],
    ['/my ship'],
    ['/ship%2Fflows'],
  ])('rejects %o', (input) => {
    expect(() => normalizeWorkflowRoutePrefix(input)).toThrowError(
      /workflows\.experimentalRoutePrefix/
    );
  });
});

describe('workflowRoutePrefixDirectory', () => {
  it('drops the leading slash so the prefix can be joined onto a directory', () => {
    expect(workflowRoutePrefixDirectory('/ship')).toBe('ship');
    expect(workflowRoutePrefixDirectory('/ship/flows')).toBe('ship/flows');
  });

  it('is empty without a prefix, which path.join drops', () => {
    expect(workflowRoutePrefixDirectory(undefined)).toBe('');
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
