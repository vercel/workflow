import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BaseBuilder } from './base-builder.js';
import type { StandaloneConfig } from './types.js';
import { hasSameContent, writeFileIfChanged } from './write-if-changed.js';

// Resolve symlinks in tmpdir to avoid macOS /var -> /private/var issues
const realTmpdir = realpathSync(tmpdir());

/** Minimal subclass exposing the protected `writeGeneratedFile()`. */
class TestBuilder extends BaseBuilder {
  async build(): Promise<void> {
    // no-op
  }

  public writeGeneratedFile(
    targetPath: string,
    content: string
  ): Promise<void> {
    return super.writeGeneratedFile(targetPath, content);
  }
}

/**
 * Stands in for a target whose consumers use the mtime of a generated file as
 * a change signal, such as the Nitro dev handler.
 */
class OptedOutBuilder extends TestBuilder {
  protected override get skipsUnchangedGeneratedWrites(): boolean {
    return false;
  }
}

function makeConfig(workingDir: string): StandaloneConfig {
  return {
    buildTarget: 'standalone',
    workingDir,
    dirs: [workingDir],
    stepsBundlePath: join(workingDir, 'steps.js'),
    workflowsBundlePath: join(workingDir, 'workflows.js'),
    webhookBundlePath: join(workingDir, 'webhook.js'),
  };
}

function createBuilder(workingDir: string): TestBuilder {
  return new TestBuilder(makeConfig(workingDir));
}

function createOptedOutBuilder(workingDir: string): OptedOutBuilder {
  return new OptedOutBuilder(makeConfig(workingDir));
}

/**
 * mtime resolution varies by filesystem, so compare the full stat identity
 * (mtime in ns plus inode) rather than trusting a millisecond timestamp.
 * `writeGeneratedFile` renames over the target, which changes the inode even
 * when the mtime happens to land in the same tick.
 */
function fileIdentity(path: string): string {
  const s = statSync(path, { bigint: true });
  return `${s.mtimeNs}:${s.ino}`;
}

let testRoot: string;

beforeEach(() => {
  testRoot = mkdtempSync(join(realTmpdir, 'write-if-changed-'));
});

afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

describe('hasSameContent', () => {
  it('is false when the file does not exist', async () => {
    await expect(
      hasSameContent(join(testRoot, 'missing.js'), 'hello')
    ).resolves.toBe(false);
  });

  it('is true for byte-identical content', async () => {
    const target = join(testRoot, 'a.js');
    writeFileSync(target, 'export const a = 1;\n');

    await expect(hasSameContent(target, 'export const a = 1;\n')).resolves.toBe(
      true
    );
  });

  it('is false when content differs at the same byte length', async () => {
    const target = join(testRoot, 'a.js');
    writeFileSync(target, 'aaaa');

    await expect(hasSameContent(target, 'aaab')).resolves.toBe(false);
  });

  it('is false when only the length differs', async () => {
    const target = join(testRoot, 'a.js');
    writeFileSync(target, 'aaaa');

    await expect(hasSameContent(target, 'aaaaa')).resolves.toBe(false);
  });

  it('compares utf-8 byte length, not code units', async () => {
    const target = join(testRoot, 'a.js');
    writeFileSync(target, '// é\u{1f600}\n', 'utf-8');

    await expect(hasSameContent(target, '// é\u{1f600}\n')).resolves.toBe(true);
  });

  it('is false for byte-different content that decodes to the same string', async () => {
    // An unpaired surrogate and U+FFFD both decode to the replacement
    // character, so a utf-8 string comparison would call these equal.
    const target = join(testRoot, 'a.js');
    writeFileSync(target, Buffer.from([0x61, 0xf0, 0x90, 0x80]));

    await expect(
      hasSameContent(target, Buffer.from([0x61, 0xef, 0xbf, 0xbd]).toString())
    ).resolves.toBe(false);
  });

  it('is false when the path is a directory', async () => {
    // Match the directory's own reported size so the check cannot pass by
    // short-circuiting on length before it ever tries to read.
    const sameSizeAsDir = 'x'.repeat(statSync(testRoot).size);

    await expect(hasSameContent(testRoot, sameSizeAsDir)).resolves.toBe(false);
  });

  it('is false when the file cannot be read', async () => {
    const target = join(testRoot, 'locked.js');
    writeFileSync(target, 'secret');
    chmodSync(target, 0o000);

    try {
      // Root ignores the mode bits, so only assert when the read really fails.
      let readable = true;
      try {
        readFileSync(target, 'utf8');
      } catch {
        readable = false;
      }
      if (readable) {
        return;
      }
      await expect(hasSameContent(target, 'secret')).resolves.toBe(false);
    } finally {
      chmodSync(target, 0o600);
    }
  });
});

describe('writeFileIfChanged', () => {
  it('creates the file when it does not exist', async () => {
    const target = join(testRoot, 'a.js');

    await expect(writeFileIfChanged(target, 'hello')).resolves.toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('hello');
  });

  it('does not touch the file when content is unchanged', async () => {
    const target = join(testRoot, 'a.js');
    await writeFileIfChanged(target, 'hello');
    const before = fileIdentity(target);

    await expect(writeFileIfChanged(target, 'hello')).resolves.toBe(false);

    expect(fileIdentity(target)).toBe(before);
  });

  it('rewrites the file when content changes', async () => {
    const target = join(testRoot, 'a.js');
    await writeFileIfChanged(target, 'hello');

    await expect(writeFileIfChanged(target, 'goodbye')).resolves.toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('goodbye');
  });
});

describe('writeGeneratedFile', () => {
  // Regression test for the dev watcher thrash: the generated routes live
  // inside the app directory the dev server watches, so a rewrite with
  // identical bytes still invalidates the bundler and forces a recompile.
  it('leaves the file untouched when the generated output is unchanged', async () => {
    const builder = createBuilder(testRoot);
    const target = join(testRoot, 'route.js');

    await builder.writeGeneratedFile(target, 'export const GET = () => {};');
    const before = fileIdentity(target);

    await builder.writeGeneratedFile(target, 'export const GET = () => {};');

    expect(fileIdentity(target)).toBe(before);
  });

  it('leaves no temp files behind when the write is skipped', async () => {
    const builder = createBuilder(testRoot);
    const target = join(testRoot, 'route.js');

    await builder.writeGeneratedFile(target, 'same');
    await builder.writeGeneratedFile(target, 'same');

    expect(readdirSync(testRoot).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('still writes when the generated output changes', async () => {
    const builder = createBuilder(testRoot);
    const target = join(testRoot, 'route.js');

    await builder.writeGeneratedFile(target, 'v1');
    await builder.writeGeneratedFile(target, 'v2');

    expect(readFileSync(target, 'utf8')).toBe('v2');
  });

  it('creates the file on first write', async () => {
    const builder = createBuilder(testRoot);
    const target = join(testRoot, 'route.js');

    await builder.writeGeneratedFile(target, 'first');

    expect(readFileSync(target, 'utf8')).toBe('first');
  });

  // The Nitro dev handler cache-busts its import of `steps.mjs` off the mtime
  // of `workflows.mjs`, so that target opts out: skipping the redundant write
  // would freeze the version key and serve stale step code. See
  // `packages/nitro/src/builders.ts`.
  it('still rewrites unchanged output when the target opts out', async () => {
    const builder = createOptedOutBuilder(testRoot);
    const target = join(testRoot, 'workflows.mjs');

    await builder.writeGeneratedFile(target, 'export const a = 1;');
    const before = fileIdentity(target);

    await builder.writeGeneratedFile(target, 'export const a = 1;');

    expect(fileIdentity(target)).not.toBe(before);
    expect(readFileSync(target, 'utf8')).toBe('export const a = 1;');
  });
});
