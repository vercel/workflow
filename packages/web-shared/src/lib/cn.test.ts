import { describe, expect, it } from 'vitest';
import { cn } from './cn';

describe('cn', () => {
  it('keeps Geist type classes next to colour classes', () => {
    // Plain `twMerge` reads `text-label-14` as a text colour and drops it here.
    expect(cn('text-label-14 text-gray-900')).toBe(
      'text-label-14 text-gray-900'
    );
    expect(cn('text-gray-900', 'text-label-13-mono')).toBe(
      'text-gray-900 text-label-13-mono'
    );
    expect(cn('text-heading-24', 'text-gray-1000')).toBe(
      'text-heading-24 text-gray-1000'
    );
    expect(cn('text-copy-14 text-red-800')).toBe('text-copy-14 text-red-800');
    expect(cn('text-button-14 text-gray-700')).toBe(
      'text-button-14 text-gray-700'
    );
  });

  it('lets the last type class of the same kind win', () => {
    expect(cn('text-label-14', 'text-label-13')).toBe('text-label-13');
    expect(cn('text-label-13 text-label-13-mono')).toBe('text-label-13-mono');
    expect(cn('text-heading-24 text-heading-32')).toBe('text-heading-32');
    expect(cn('text-copy-14', 'text-copy-16')).toBe('text-copy-16');
    expect(cn('text-button-12', 'text-button-16')).toBe('text-button-16');
  });

  it('keeps resolving colour conflicts while a type class is present', () => {
    expect(cn('text-label-14 text-gray-700', 'text-gray-900')).toBe(
      'text-label-14 text-gray-900'
    );
  });

  it('accepts conditional inputs', () => {
    expect(
      cn('text-label-14', false, undefined, { 'text-gray-900': true })
    ).toBe('text-label-14 text-gray-900');
  });
});
