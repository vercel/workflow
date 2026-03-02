export const DEFERRED_STEP_COPY_DIR_NAME = '__workflow_step_files__';
export const DEFERRED_STEP_SOURCE_METADATA_PREFIX = 'WORKFLOW_STEP_SOURCE_B64:';
const INLINE_SOURCE_MAP_PATTERN =
  /(?:^|\r?\n)\s*\/\/[#@]\s*sourceMappingURL=data:application\/json(?:;charset=[^;,]+)?;base64,([A-Za-z0-9+/=]+)\s*$/;

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

function getLineCount(source: string): number {
  if (source.length === 0) {
    return 1;
  }
  const lineBreakMatches = source.match(/\r\n|\r|\n/g);
  return (lineBreakMatches?.length ?? 0) + 1;
}

function createIdentityLineMappings(lineCount: number): string {
  if (lineCount <= 1) {
    return 'AAAA';
  }
  return `AAAA${';AACA'.repeat(lineCount - 1)}`;
}

export function createDeferredStepCopyInlineSourceMapComment({
  sourcePath,
  sourceContent,
  generatedContent,
}: {
  sourcePath: string;
  sourceContent: string;
  generatedContent?: string;
}): string {
  const normalizedSourcePath = normalizePath(sourcePath);
  const sourceMap = {
    version: 3,
    file: normalizedSourcePath.split('/').pop() ?? normalizedSourcePath,
    sources: [normalizedSourcePath],
    sourcesContent: [sourceContent],
    names: [] as string[],
    mappings: createIdentityLineMappings(
      getLineCount(generatedContent ?? sourceContent)
    ),
  };
  const encodedSourceMap = Buffer.from(
    JSON.stringify(sourceMap),
    'utf-8'
  ).toString('base64');
  return `//# sourceMappingURL=data:application/json;base64,${encodedSourceMap}`;
}

export function parseInlineSourceMapComment(source: string): {
  sourceWithoutMapComment: string;
  sourceMap: string | null;
} {
  const mapMatch = source.match(INLINE_SOURCE_MAP_PATTERN);
  if (!mapMatch?.[1]) {
    return {
      sourceWithoutMapComment: source,
      sourceMap: null,
    };
  }

  const sourceWithoutMapComment = source.replace(INLINE_SOURCE_MAP_PATTERN, '');
  try {
    const decodedMap = Buffer.from(mapMatch[1], 'base64').toString('utf-8');
    JSON.parse(decodedMap);
    return {
      sourceWithoutMapComment,
      sourceMap: decodedMap,
    };
  } catch {
    return {
      sourceWithoutMapComment,
      sourceMap: null,
    };
  }
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
