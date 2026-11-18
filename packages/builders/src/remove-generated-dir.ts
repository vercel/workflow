import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

export async function removeGeneratedDir(dir: string): Promise<void> {
  const marker = await readFile(join(dir, '.gitignore'), 'utf-8').catch(
    () => undefined
  );
  if (marker?.trim() === '*') {
    await rm(dir, { recursive: true, force: true });
  }
}
