import type { Nitro } from 'nitro/types';
import { describe, expect, test } from 'vitest';
import { getWorkflowDirs } from '../src/builders.ts';

const nitroMock = (dirs: string[]) => {
  return {
    options: {
      rootDir: '/root',
      scanDirs: ['/root/server/'],
      workflow: { dirs: dirs },
    },
  } as unknown as Nitro;
};

describe('nitro:getWorkflowDirs', () => {
  test('default dirs', () => {
    const result = getWorkflowDirs(nitroMock([]));
    expect(result).toEqual(['/root/server/workflows', '/root/workflows']);
  });

  test('custom dirs', () => {
    const result = getWorkflowDirs(
      nitroMock(['./relative/dir1', '/custom/dir2'])
    );
    expect(result).toEqual([
      '/custom/dir2',
      '/root/relative/dir1',
      '/root/server/workflows',
      '/root/workflows',
    ]);
  });
});
