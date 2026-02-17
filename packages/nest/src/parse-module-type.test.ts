import { describe, expect, it } from 'vitest';
import { parseModuleType } from './parse-module-type.js';

describe('parseModuleType', () => {
  it('returns es6 when --module is absent', () => {
    expect(parseModuleType(['init'])).toBe('es6');
    expect(parseModuleType([])).toBe('es6');
  });

  it('returns es6 when --module es6', () => {
    expect(parseModuleType(['init', '--module', 'es6'])).toBe('es6');
  });

  it('returns commonjs when --module commonjs', () => {
    expect(parseModuleType(['init', '--module', 'commonjs'])).toBe('commonjs');
  });

  it('returns null when --module has invalid value', () => {
    expect(parseModuleType(['init', '--module', 'umd'])).toBe(null);
    expect(parseModuleType(['--module', 'invalid'])).toBe(null);
  });

  it('returns es6 when --module is last arg (no value)', () => {
    expect(parseModuleType(['init', '--module'])).toBe('es6');
  });
});
