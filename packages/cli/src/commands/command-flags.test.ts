import { describe, expect, it } from 'vitest';
import Cancel from './cancel.js';
import Delete from './delete.js';
import Start from './start.js';

/**
 * Each command declares only the flags it reads. A flag the parser accepts
 * but the command ignores (say `--limit` on `delete`) reads in `--help`
 * as if it scoped the command, and is silently dropped. These pin each set,
 * so adding one is a deliberate change here too.
 */
const TARGET_FLAGS = [
  'authToken',
  'backend',
  'env',
  'json',
  'project',
  'team',
  'verbose',
];

describe('command flags', () => {
  it.each([
    ['delete', Delete.flags, [...TARGET_FLAGS, 'confirm', 'strict']],
    [
      'cancel',
      Cancel.flags,
      [...TARGET_FLAGS, 'confirm', 'limit', 'status', 'workflowName'],
    ],
    ['start', Start.flags, [...TARGET_FLAGS, 'branch', 'deployment']],
  ])('%s declares only the flags it uses', (_name, flags, expected) => {
    expect(Object.keys(flags).sort()).toEqual([...expected].sort());
  });
});
