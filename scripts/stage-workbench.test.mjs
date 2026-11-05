import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { copySymlinkTargets } from './stage-workbench.mjs';

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function tempDir() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-stage-test-')
  );
  temporaryDirectories.push(directory);
  return directory;
}

describe('copySymlinkTargets', () => {
  it('replaces every symlink the staged copy lost with what it points at', () => {
    const root = tempDir();
    // A sibling the workbench shares files with, as nextjs-webpack does.
    const shared = path.join(root, 'shared');
    fs.mkdirSync(path.join(shared, 'components'), { recursive: true });
    fs.writeFileSync(path.join(shared, 'components', 'button.tsx'), 'button');
    fs.writeFileSync(path.join(shared, 'tsconfig.json'), '{}');
    fs.writeFileSync(path.join(shared, 'route.ts'), 'route');

    const source = path.join(root, 'app');
    fs.mkdirSync(path.join(source, 'app', 'api', 'chat'), { recursive: true });
    fs.writeFileSync(path.join(source, 'page.tsx'), 'page');
    fs.symlinkSync('../shared/components', path.join(source, 'components'));
    fs.symlinkSync(
      '../shared/tsconfig.json',
      path.join(source, 'tsconfig.json')
    );
    // A directory holding only a symlink: the staged copy has no such directory.
    fs.symlinkSync(
      '../../../../shared/route.ts',
      path.join(source, 'app', 'api', 'chat', 'route.ts')
    );
    fs.mkdirSync(path.join(source, 'node_modules', 'dep'), { recursive: true });
    fs.symlinkSync(
      '../../../shared',
      path.join(source, 'node_modules', 'dep', 'link')
    );

    // What `pnpm deploy` leaves: the real files, no symlinks.
    const staged = path.join(root, 'staged');
    fs.mkdirSync(staged);
    fs.writeFileSync(path.join(staged, 'page.tsx'), 'page');

    copySymlinkTargets(source, staged);

    expect(
      fs.readFileSync(path.join(staged, 'components', 'button.tsx'), 'utf8')
    ).toBe('button');
    expect(fs.readFileSync(path.join(staged, 'tsconfig.json'), 'utf8')).toBe(
      '{}'
    );
    expect(
      fs.readFileSync(
        path.join(staged, 'app', 'api', 'chat', 'route.ts'),
        'utf8'
      )
    ).toBe('route');
    expect(fs.lstatSync(path.join(staged, 'components')).isSymbolicLink()).toBe(
      false
    );
    // node_modules is the install's, never copied from the source.
    expect(fs.existsSync(path.join(staged, 'node_modules'))).toBe(false);
  });
});
