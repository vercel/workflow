import { access, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

const workflowAliasResolutionCache = new Map<
  string,
  Promise<string | undefined>
>();

const WORKFLOW_ALIAS_ROOTS = [
  'src/workflows',
  'workflows',
  'src/app',
  'app',
  'src/pages',
  'pages',
] as const;

function getAliasRelativePathCandidates(
  normalizedAbsolutePath: string
): string[] {
  const candidates = new Set<string>();
  for (const aliasRoot of WORKFLOW_ALIAS_ROOTS) {
    const marker = `/${aliasRoot}/`;
    const markerIndex = normalizedAbsolutePath.lastIndexOf(marker);
    if (markerIndex === -1) {
      continue;
    }
    candidates.add(normalizedAbsolutePath.slice(markerIndex + 1));
  }
  return Array.from(candidates);
}

export function clearWorkflowAliasResolutionCache(): void {
  workflowAliasResolutionCache.clear();
}

export async function resolveWorkflowAliasRelativePath(
  absoluteFilePath: string,
  workingDir: string
): Promise<string | undefined> {
  const normalizedAbsolutePath = absoluteFilePath.replace(/\\/g, '/');

  const cacheKey = `${workingDir}::${normalizedAbsolutePath}`;
  const cached = workflowAliasResolutionCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const resolutionPromise = (async () => {
    const resolvedFilePath = await realpath(absoluteFilePath).catch(
      () => undefined
    );
    if (!resolvedFilePath) {
      return undefined;
    }
    const normalizedResolvedFilePath = resolvedFilePath.replace(/\\/g, '/');
    const aliasCandidates = getAliasRelativePathCandidates(
      normalizedAbsolutePath
    );
    if (aliasCandidates.length === 0) {
      return undefined;
    }

    for (const aliasRelativePath of aliasCandidates) {
      const candidatePath = resolve(workingDir, aliasRelativePath);
      try {
        await access(candidatePath);
      } catch {
        continue;
      }
      const resolvedCandidatePath = await realpath(candidatePath).catch(
        () => undefined
      );
      if (!resolvedCandidatePath) {
        continue;
      }
      if (
        resolvedCandidatePath.replace(/\\/g, '/') === normalizedResolvedFilePath
      ) {
        return aliasRelativePath;
      }
    }
    return undefined;
  })();

  workflowAliasResolutionCache.set(cacheKey, resolutionPromise);
  return resolutionPromise;
}
