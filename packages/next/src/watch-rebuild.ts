import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

export interface DiscoveredEntriesLike {
  discoveredSteps: Set<string>;
  discoveredWorkflows: Set<string>;
  discoveredSerdeFiles: Set<string>;
  discoveredFiles: Set<string>;
}

export type ScheduledRebuild =
  | { kind: 'files'; files: string[] }
  | { kind: 'full' };

export interface SourceSnapshot {
  sourceHash: string;
  importSignature: string;
  hasDirective: boolean;
  hasSerde: boolean;
}

export type RebuildDecision =
  | { kind: 'skip'; snapshots: Map<string, SourceSnapshot> }
  | {
      kind: 'hot';
      refreshStepRegistrations: boolean;
      snapshots: Map<string, SourceSnapshot>;
    }
  | { kind: 'full' };

export type SourcePatternDetector = (source: string) => {
  hasDirective: boolean;
  hasSerde: boolean;
};

const importSpecifierPatterns = [
  /\bfrom\s+['"]([^'"]+)['"]/g,
  /(?:^|[;\n])\s*import\s+['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];
const defaultNormalizePath = (pathname: string) => pathname.replace(/\\/g, '/');
const sourceExtensions = new Set([
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.cjs',
  '.mjs',
]);

export const isSourceFile = (file: string) =>
  sourceExtensions.has(extname(file));

const REGEX_PREFIX_CHARS = new Set([
  '(',
  '{',
  '[',
  '=',
  ':',
  ',',
  ';',
  '!',
  '?',
  '&',
  '|',
  '+',
  '-',
  '*',
  '~',
  '^',
  '<',
  '>',
  '%',
]);
const REGEX_PREFIX_KEYWORDS =
  /\b(?:return|throw|case|delete|void|typeof|instanceof|in|yield|await)$/;

const canStartRegexLiteral = (output: string) => {
  const previous = output.trimEnd();
  if (previous.length === 0) {
    return true;
  }
  const previousChar = previous[previous.length - 1];
  return (
    REGEX_PREFIX_CHARS.has(previousChar) || REGEX_PREFIX_KEYWORDS.test(previous)
  );
};

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep the string/comment/regex scanner local and allocation-light.
export const stripCommentsFromSource = (source: string) => {
  let output = '';
  let index = 0;
  let quote: '"' | "'" | '`' | undefined;
  let regex = false;
  let regexCharClass = false;
  let escaped = false;

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (quote || regex) {
      output += char;
      index++;

      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (quote && char === quote) {
        quote = undefined;
      } else if (regex && char === '[') {
        regexCharClass = true;
      } else if (regex && char === ']') {
        regexCharClass = false;
      } else if (regex && char === '/' && !regexCharClass) {
        regex = false;
      }
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      output += char;
      index++;
      continue;
    }

    if (
      char === '/' &&
      next !== '/' &&
      next !== '*' &&
      canStartRegexLiteral(output)
    ) {
      regex = true;
      output += char;
      index++;
      continue;
    }

    if (char === '/' && next === '/') {
      output += '  ';
      index += 2;
      while (index < source.length && source[index] !== '\n') {
        output += ' ';
        index++;
      }
      continue;
    }

    if (char === '/' && next === '*') {
      output += '  ';
      index += 2;
      while (index < source.length) {
        const blockChar = source[index];
        const blockNext = source[index + 1];
        if (blockChar === '*' && blockNext === '/') {
          output += '  ';
          index += 2;
          break;
        }
        output += blockChar === '\n' ? '\n' : ' ';
        index++;
      }
      continue;
    }

    output += char;
    index++;
  }

  return output;
};

const sourceMayContainImportSpecifiers = (source: string) =>
  source.includes('import') ||
  source.includes('require') ||
  source.includes('from');

const collectImportSpecifiers = (source: string) => {
  const specifiers = new Set<string>();
  for (const pattern of importSpecifierPatterns) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      if (match[1]) {
        specifiers.add(match[1]);
      }
    }
  }
  return [...specifiers].sort().join('\n');
};

export const extractImportSignature = (source: string) =>
  sourceMayContainImportSpecifiers(source)
    ? collectImportSpecifiers(source)
    : '';

export const createSourceSnapshotFromSource = (
  source: string,
  detectWorkflowPatterns: SourcePatternDetector
): SourceSnapshot => {
  const sourceWithoutComments = stripCommentsFromSource(source);
  const patterns = detectWorkflowPatterns(sourceWithoutComments);

  return {
    sourceHash: createHash('sha256').update(source).digest('base64url'),
    importSignature: extractImportSignature(sourceWithoutComments),
    hasDirective: patterns.hasDirective,
    hasSerde: patterns.hasSerde,
  };
};

export const createSourceSnapshot = async ({
  file,
  detectWorkflowPatterns,
}: {
  file: string;
  detectWorkflowPatterns: SourcePatternDetector;
}): Promise<SourceSnapshot> => {
  const contents = await readFile(file);
  if (isSourceFile(file)) {
    return createSourceSnapshotFromSource(
      contents.toString('utf8'),
      detectWorkflowPatterns
    );
  }
  return {
    sourceHash: createHash('sha256').update(contents).digest('base64url'),
    importSignature: '',
    hasDirective: false,
    hasSerde: false,
  };
};

export const getRelevantFiles = ({
  discoveredEntries,
  inputFiles,
  normalizePath = defaultNormalizePath,
}: {
  discoveredEntries: DiscoveredEntriesLike;
  inputFiles: string[];
  normalizePath?: (path: string) => string;
}) =>
  new Set(
    [...inputFiles, ...discoveredEntries.discoveredFiles].map(normalizePath)
  );

export const readSourceSnapshots = async ({
  discoveredEntries,
  inputFiles,
  normalizePath = defaultNormalizePath,
  readSnapshot,
}: {
  discoveredEntries: DiscoveredEntriesLike;
  inputFiles: string[];
  normalizePath?: (path: string) => string;
  readSnapshot: (file: string) => Promise<SourceSnapshot>;
}) => {
  const snapshots = new Map<string, SourceSnapshot>();
  await Promise.all(
    [
      ...getRelevantFiles({
        discoveredEntries,
        inputFiles,
        normalizePath,
      }),
    ].map(async (file) => {
      try {
        snapshots.set(file, await readSnapshot(file));
      } catch {}
    })
  );
  return snapshots;
};

const requiresFullRediscovery = (
  previousSnapshot: SourceSnapshot,
  nextSnapshot: SourceSnapshot
) => {
  if (previousSnapshot.hasDirective || nextSnapshot.hasDirective) {
    return true;
  }

  // Serde edits can change the generated class manifest. Rediscover all of
  // them instead of approximating JavaScript class structure with a regex.
  if (previousSnapshot.hasSerde || nextSnapshot.hasSerde) {
    return true;
  }

  return previousSnapshot.importSignature !== nextSnapshot.importSignature;
};

export const sourceSnapshotsMatch = (
  left: Map<string, SourceSnapshot>,
  right: Map<string, SourceSnapshot>
) =>
  left.size === right.size &&
  [...left].every(
    ([file, snapshot]) => snapshot.sourceHash === right.get(file)?.sourceHash
  );

export const createRebuildScheduler = (
  rebuild: (request: ScheduledRebuild) => Promise<void>,
  onIdle: () => void
) => {
  let pending: ScheduledRebuild | undefined;
  let rebuilding = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = async () => {
    if (rebuilding || timer || !pending) {
      return;
    }

    const request = pending;
    pending = undefined;
    rebuilding = true;
    try {
      await rebuild(request);
    } finally {
      rebuilding = false;
      if (pending && !timer) {
        void flush();
      } else if (!pending) {
        onIdle();
      }
    }
  };

  return (request: ScheduledRebuild) => {
    switch (request.kind) {
      case 'files':
        if (rebuilding) {
          pending = { kind: 'full' };
        } else if (pending?.kind !== 'full') {
          pending = {
            kind: 'files',
            files: [...new Set([...(pending?.files ?? []), ...request.files])],
          };
        }
        break;
      case 'full':
        pending = request;
        break;
      default:
        request satisfies never;
        throw new Error('Unknown scheduled rebuild');
    }

    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, 100);
  };
};

const workflowEntryFilesChanged = ({
  changedFiles,
  discoveredEntries,
  normalizePath,
  parentHasChild,
}: {
  changedFiles: string[];
  discoveredEntries: DiscoveredEntriesLike;
  normalizePath: (path: string) => string;
  parentHasChild: (
    parent: string,
    child: string,
    options?: { excludedRoots?: Iterable<string> }
  ) => boolean;
}) => {
  const workflowEntryFiles = [
    ...discoveredEntries.discoveredWorkflows,
    ...discoveredEntries.discoveredSerdeFiles,
  ].map(normalizePath);
  const stepEntryFiles = [...discoveredEntries.discoveredSteps].map(
    normalizePath
  );

  return changedFiles.some((changedFile) => {
    if (workflowEntryFiles.includes(changedFile)) {
      return true;
    }
    if (stepEntryFiles.includes(changedFile)) {
      return false;
    }
    return workflowEntryFiles.some((workflowFile) =>
      parentHasChild(workflowFile, changedFile, {
        excludedRoots: stepEntryFiles,
      })
    );
  });
};

const stepRegistrationsNeedRefresh = ({
  changedFiles,
  discoveredEntries,
  normalizePath,
}: {
  changedFiles: string[];
  discoveredEntries: DiscoveredEntriesLike;
  normalizePath: (path: string) => string;
}) => {
  const serdeFiles = new Set(
    [...discoveredEntries.discoveredSerdeFiles].map(normalizePath)
  );
  return changedFiles.some((file) => serdeFiles.has(file));
};

export const classifyRebuild = async ({
  files,
  discoveredEntries,
  inputFiles,
  normalizePath = defaultNormalizePath,
  parentHasChild,
  readSnapshot,
  sourceSnapshots,
}: {
  files: string[];
  discoveredEntries: DiscoveredEntriesLike;
  inputFiles: string[];
  normalizePath?: (path: string) => string;
  parentHasChild: (
    parent: string,
    child: string,
    options?: { excludedRoots?: Iterable<string> }
  ) => boolean;
  readSnapshot: (file: string) => Promise<SourceSnapshot>;
  sourceSnapshots: Map<string, SourceSnapshot>;
}): Promise<RebuildDecision> => {
  const relevantFiles = getRelevantFiles({
    discoveredEntries,
    inputFiles,
    normalizePath,
  });
  const snapshots = new Map<string, SourceSnapshot>();
  for (const file of files) {
    if (relevantFiles.has(file) && !isSourceFile(file)) {
      return { kind: 'full' };
    }

    let nextSnapshot: SourceSnapshot;
    try {
      nextSnapshot = await readSnapshot(file);
    } catch {
      if (relevantFiles.has(file)) {
        return { kind: 'full' };
      }
      continue;
    }

    const previousSnapshot = sourceSnapshots.get(file);
    if (!previousSnapshot) {
      if (
        relevantFiles.has(file) ||
        nextSnapshot.importSignature ||
        nextSnapshot.hasDirective ||
        nextSnapshot.hasSerde
      ) {
        return { kind: 'full' };
      }
      continue;
    }
    if (requiresFullRediscovery(previousSnapshot, nextSnapshot)) {
      return { kind: 'full' };
    }
    if (previousSnapshot.sourceHash === nextSnapshot.sourceHash) {
      return { kind: 'full' };
    }
    snapshots.set(file, nextSnapshot);
  }

  const changedFiles = [...snapshots.keys()];
  return workflowEntryFilesChanged({
    changedFiles,
    discoveredEntries,
    normalizePath,
    parentHasChild,
  })
    ? {
        kind: 'hot',
        refreshStepRegistrations: stepRegistrationsNeedRefresh({
          changedFiles,
          discoveredEntries,
          normalizePath,
        }),
        snapshots,
      }
    : { kind: 'skip', snapshots };
};
