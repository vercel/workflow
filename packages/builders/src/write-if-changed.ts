import { readFile, stat, writeFile } from 'node:fs/promises';

/**
 * Reports whether `targetPath` already holds exactly `content`.
 *
 * Generated files are rewritten on every rebuild, and in dev most rebuilds
 * produce byte-identical output. Rewriting anyway bumps the mtime (and, for
 * the rename-based atomic write, the inode) of a file that lives inside the
 * app directory the dev server watches, so the bundler sees a change and
 * recompiles. Comparing first lets the caller skip the write entirely.
 *
 * Any read failure (missing file, permissions) reports `false`, so the caller
 * falls back to writing.
 */
export async function hasSameContent(
  targetPath: string,
  content: string
): Promise<boolean> {
  try {
    // Compare bytes rather than decoded strings: utf-8 decoding is lossy, so
    // two different byte sequences can decode to the same string and a real
    // change would be skipped.
    const expected = Buffer.from(content, 'utf8');
    // Reject on size before reading the file, which for the generated bundle
    // is the expensive half.
    const { size } = await stat(targetPath);
    if (size !== expected.byteLength) {
      return false;
    }
    return Buffer.compare(await readFile(targetPath), expected) === 0;
  } catch {
    return false;
  }
}

/**
 * `writeFile`, skipped when the file already holds `content`.
 *
 * Returns whether the file was actually written.
 */
export async function writeFileIfChanged(
  targetPath: string,
  content: string
): Promise<boolean> {
  if (await hasSameContent(targetPath, content)) {
    return false;
  }
  await writeFile(targetPath, content);
  return true;
}
