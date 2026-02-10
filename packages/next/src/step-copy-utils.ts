export const DEFERRED_STEP_COPY_DIR_NAME = '__workflow_step_files__';
export const DEFERRED_STEP_SOURCE_METADATA_PREFIX = 'WORKFLOW_STEP_SOURCE_B64:';

export interface DeferredStepSourceMetadata {
  relativeFilename: string;
  absolutePath: string;
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

export function isDeferredStepCopyFilePath(filePath: string): boolean {
  const normalizedPath = normalizePath(filePath);
  return normalizedPath.includes(
    `/.well-known/workflow/v1/step/${DEFERRED_STEP_COPY_DIR_NAME}/`
  );
}

export function createDeferredStepSourceMetadataComment(
  metadata: DeferredStepSourceMetadata
): string {
  const encoded = Buffer.from(JSON.stringify(metadata), 'utf-8').toString(
    'base64'
  );
  return `// ${DEFERRED_STEP_SOURCE_METADATA_PREFIX}${encoded}`;
}

export function parseDeferredStepSourceMetadata(
  source: string
): DeferredStepSourceMetadata | null {
  const pattern = new RegExp(
    `^\\s*//\\s*${escapeRegExp(DEFERRED_STEP_SOURCE_METADATA_PREFIX)}([A-Za-z0-9+/=]+)\\s*$`,
    'm'
  );
  const match = source.match(pattern);
  const encoded = match?.[1];
  if (!encoded) {
    return null;
  }

  try {
    const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
    const parsed = JSON.parse(decoded) as Partial<DeferredStepSourceMetadata>;
    if (
      typeof parsed.relativeFilename !== 'string' ||
      parsed.relativeFilename.length === 0 ||
      typeof parsed.absolutePath !== 'string' ||
      parsed.absolutePath.length === 0
    ) {
      return null;
    }

    return {
      relativeFilename: parsed.relativeFilename,
      absolutePath: normalizePath(parsed.absolutePath),
    };
  } catch {
    return null;
  }
}
