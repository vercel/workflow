import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  findOpacityColourViolations,
  formatViolations,
} from './opacity-colour-rules';

describe('@workflow/web-shared colours', () => {
  it('never uses opacity to set a colour (see AGENTS.md)', () => {
    const violations = findOpacityColourViolations(
      resolve(__dirname, '../src'),
      ['styles.css']
    );
    expect(formatViolations(violations)).toBe('');
  });
});
