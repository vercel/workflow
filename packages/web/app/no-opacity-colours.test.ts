import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  findOpacityColourViolations,
  formatViolations,
} from '../../web-shared/test/opacity-colour-rules';

describe('@workflow/web colours', () => {
  it('never uses opacity to set a colour (see packages/web-shared/AGENTS.md)', () => {
    const violations = findOpacityColourViolations(resolve(__dirname), [
      'globals.css',
    ]);
    expect(formatViolations(violations)).toBe('');
  });
});
