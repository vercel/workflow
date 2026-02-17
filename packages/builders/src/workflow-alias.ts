import { access, realpath } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

const workflowAliasResolutionCache = new Map<
  string,
  Promise<string | undefined>
>();

export function clearWorkflowAliasResolutionCache(): void {
  workflowAliasResolutionCache.clear();
}

export async function resolveWorkflowAliasRelativePath(
  absoluteFilePath: string,
  workingDir: string
): Promise<string | undefined> {
  const normalizedAbsolutePath = absoluteFilePath.replace(/\\/g, '/');
  // Only workflow source files can map to app-level `workflows/*` aliases.
  if (!normalizedAbsolutePath.includes('/workflows/')) {
    return undefined;
  }

  const cacheKey = `${workingDir}::${normalizedAbsolutePath}`;
  const cached = workflowAliasResolutionCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const resolutionPromise = (async () => {
    const fileName = basename(absoluteFilePath);
    const aliasDirs = ['workflows', 'src/workflows'];
    const resolvedFilePath = await realpath(absoluteFilePath).catch(
      () => undefined
    );
    if (!resolvedFilePath) {
      return undefined;
    }

    const aliases = await Promise.all(
      aliasDirs.map(async (aliasDir) => {
        const candidatePath = resolve(workingDir, aliasDir, fileName);
        try {
          await access(candidatePath);
        } catch {
          return undefined;
        }
        const resolvedCandidatePath = await realpath(candidatePath).catch(
          () => undefined
        );
        if (!resolvedCandidatePath) {
          return undefined;
        }
        return resolvedCandidatePath === resolvedFilePath
          ? `${aliasDir}/${fileName}`
          : undefined;
      })
    );

    return aliases.find((aliasPath): aliasPath is string => Boolean(aliasPath));
  })();

  workflowAliasResolutionCache.set(cacheKey, resolutionPromise);
  return resolutionPromise;
}
