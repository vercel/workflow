import { describe, expect, it } from 'vitest';
import { normalizeResource } from '../../commands/inspect.js';

describe('normalizeResource', () => {
  // `st` is the documented stream alias; it fell through to the `s` (step)
  // arm and listed steps.
  it('reads the st alias as stream', () => {
    expect(normalizeResource('st')).toBe('stream');
    expect(normalizeResource('ST')).toBe('stream');
  });

  it.each([
    ['s', 'step'],
    ['step', 'step'],
    ['steps', 'step'],
    ['stream', 'stream'],
    ['streams', 'stream'],
    ['sl', 'sleep'],
    ['sleeps', 'sleep'],
    ['r', 'run'],
    ['e', 'event'],
    ['h', 'hook'],
    ['w', 'web'],
  ] as const)('maps %s to %s', (value, expected) => {
    expect(normalizeResource(value)).toBe(expected);
  });
});
