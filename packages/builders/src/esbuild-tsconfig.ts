import { lstat, readFile } from 'node:fs/promises';

export type EsbuildTsconfigOptions = {
  tsconfig?: string;
  tsconfigRaw?: string;
};

/**
 * Returns the appropriate tsconfig options for esbuild.
 *
 * For symlinked tsconfig files we pass `tsconfigRaw` instead of `tsconfig` so
 * path aliases (for example `@/*`) are resolved relative to the current
 * working directory instead of the symlink target directory.
 */
export async function getEsbuildTsconfigOptions(
  tsconfigPath: string | undefined
): Promise<EsbuildTsconfigOptions> {
  if (!tsconfigPath) {
    return {};
  }

  try {
    const stats = await lstat(tsconfigPath);
    if (!stats.isSymbolicLink()) {
      return { tsconfig: tsconfigPath };
    }

    const tsconfigRaw = await readFile(tsconfigPath, 'utf8');
    return { tsconfigRaw };
  } catch {
    return { tsconfig: tsconfigPath };
  }
}
