import { readFile } from 'node:fs/promises';

export interface DiscoveredEntriesLike {
  discoveredSteps: Set<string>;
  discoveredWorkflows: Set<string>;
  discoveredSerdeFiles: Set<string>;
  discoveredFiles?: Set<string>;
}

export interface FileChanges {
  addedFiles: string[];
  modifiedFiles: string[];
  removedFiles: string[];
}

export interface SourceSnapshot {
  importSignature: string;
  definitionSignature: string;
  hasDirective: boolean;
  hasSerde: boolean;
}

export type RebuildDecision =
  | { kind: 'none'; snapshots?: Map<string, SourceSnapshot> }
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
const directiveFunctionPatterns = [
  /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)[^{]*\{\s*['"]use\s+(workflow|step)['"]/g,
  /\b(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{\s*['"]use\s+(workflow|step)['"]/g,
];
const serdeClassPattern =
  /\bclass\s+([A-Za-z_$][\w$]*)[\s\S]*?(?:static\s+classId\s*=\s*['"]([^'"]+)['"]|Symbol\.for\s*\(\s*['"]workflow-(?:serialize|deserialize)['"]\s*\)|\[\s*WORKFLOW_(?:SERIALIZE|DESERIALIZE)\s*\])/g;

const defaultNormalizePath = (pathname: string) => pathname.replace(/\\/g, '/');

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

export const extractDefinitionSignature = (source: string) => {
  const definitions: string[] = [];
  for (const pattern of directiveFunctionPatterns) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      definitions.push(`${match[2]}:${match[1]}`);
    }
  }
  serdeClassPattern.lastIndex = 0;
  for (const match of source.matchAll(serdeClassPattern)) {
    definitions.push(`serde:${match[2] ?? match[1]}`);
  }
  return definitions.sort().join('\n');
};

export const createSourceSnapshotFromSource = (
  source: string,
  detectWorkflowPatterns: SourcePatternDetector
): SourceSnapshot => {
  const sourceWithoutComments = stripCommentsFromSource(source);
  const patterns = detectWorkflowPatterns(sourceWithoutComments);

  return {
    importSignature: extractImportSignature(sourceWithoutComments),
    definitionSignature: extractDefinitionSignature(sourceWithoutComments),
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
}): Promise<SourceSnapshot> =>
  createSourceSnapshotFromSource(
    await readFile(file, 'utf8'),
    detectWorkflowPatterns
  );

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
    [
      ...inputFiles,
      ...discoveredEntries.discoveredSteps,
      ...discoveredEntries.discoveredWorkflows,
      ...discoveredEntries.discoveredSerdeFiles,
      ...(discoveredEntries.discoveredFiles || []),
    ].map(normalizePath)
  );

export const replaceSourceSnapshots = async ({
  discoveredEntries,
  inputFiles,
  normalizePath = defaultNormalizePath,
  readSnapshot,
  sourceSnapshots,
}: {
  discoveredEntries: DiscoveredEntriesLike;
  inputFiles: string[];
  normalizePath?: (path: string) => string;
  readSnapshot: (file: string) => Promise<SourceSnapshot>;
  sourceSnapshots: Map<string, SourceSnapshot>;
}) => {
  sourceSnapshots.clear();
  await Promise.all(
    [
      ...getRelevantFiles({
        discoveredEntries,
        inputFiles,
        normalizePath,
      }),
    ].map(async (file) => {
      try {
        sourceSnapshots.set(file, await readSnapshot(file));
      } catch {
        sourceSnapshots.delete(file);
      }
    })
  );
};

const didSourceSnapshotChange = (
  previousSnapshot: SourceSnapshot,
  nextSnapshot: SourceSnapshot
) =>
  previousSnapshot.importSignature !== nextSnapshot.importSignature ||
  previousSnapshot.definitionSignature !== nextSnapshot.definitionSignature ||
  previousSnapshot.hasDirective !== nextSnapshot.hasDirective ||
  previousSnapshot.hasSerde !== nextSnapshot.hasSerde;

const unique = (paths: string[]) => [...new Set(paths)];

const snapshotChangedFile = async ({
  file,
  nextSnapshots,
  readSnapshot,
  sourceSnapshots,
}: {
  file: string;
  nextSnapshots: Map<string, SourceSnapshot>;
  readSnapshot: (file: string) => Promise<SourceSnapshot>;
  sourceSnapshots: Map<string, SourceSnapshot>;
}) => {
  const previousSnapshot = sourceSnapshots.get(file);
  if (!previousSnapshot) {
    return false;
  }

  const nextSnapshot = await readSnapshot(file);
  if (didSourceSnapshotChange(previousSnapshot, nextSnapshot)) {
    return false;
  }

  nextSnapshots.set(file, nextSnapshot);
  return true;
};

const removedFilesRequireFullRebuild = ({
  discoveredEntries,
  inputFiles,
  normalizePath,
  removedFiles,
}: {
  discoveredEntries: DiscoveredEntriesLike;
  inputFiles: string[];
  normalizePath: (path: string) => string;
  removedFiles: string[];
}) => {
  const relevantFiles = getRelevantFiles({
    discoveredEntries,
    inputFiles,
    normalizePath,
  });
  return removedFiles.some((file) => relevantFiles.has(file));
};

const addedFilesRequireFullRebuild = async ({
  addedFiles,
  readSnapshot,
}: {
  addedFiles: string[];
  readSnapshot: (file: string) => Promise<SourceSnapshot>;
}) => {
  for (const file of addedFiles) {
    try {
      const snapshot = await readSnapshot(file);
      if (snapshot.hasDirective || snapshot.hasSerde) {
        return true;
      }
    } catch {
      return true;
    }
  }
  return false;
};

const pruneStaleAddedFiles = async ({
  addedFiles,
  readSnapshot,
  sourceSnapshots,
}: {
  addedFiles: string[];
  readSnapshot: (file: string) => Promise<SourceSnapshot>;
  sourceSnapshots: Map<string, SourceSnapshot>;
}) => {
  const nextAddedFiles: string[] = [];
  const snapshots = new Map<string, SourceSnapshot>();

  for (const file of unique(addedFiles)) {
    const previousSnapshot = sourceSnapshots.get(file);
    if (!previousSnapshot) {
      nextAddedFiles.push(file);
      continue;
    }

    try {
      const nextSnapshot = await readSnapshot(file);
      if (didSourceSnapshotChange(previousSnapshot, nextSnapshot)) {
        nextAddedFiles.push(file);
        continue;
      }
      snapshots.set(file, nextSnapshot);
    } catch {
      nextAddedFiles.push(file);
    }
  }

  return { addedFiles: nextAddedFiles, snapshots };
};

const modifiedFilesRequireFullRebuild = async ({
  modifiedFiles,
  readSnapshot,
  sourceSnapshots,
}: {
  modifiedFiles: string[];
  readSnapshot: (file: string) => Promise<SourceSnapshot>;
  sourceSnapshots: Map<string, SourceSnapshot>;
}) => {
  for (const file of unique(modifiedFiles)) {
    try {
      const nextSnapshot = await readSnapshot(file);
      const previousSnapshot = sourceSnapshots.get(file);
      if (!previousSnapshot) {
        if (
          nextSnapshot.importSignature ||
          nextSnapshot.definitionSignature ||
          nextSnapshot.hasDirective ||
          nextSnapshot.hasSerde
        ) {
          return true;
        }
        continue;
      }
      if (didSourceSnapshotChange(previousSnapshot, nextSnapshot)) {
        return true;
      }
    } catch {
      return true;
    }
  }
  return false;
};

const getChangedRelevantFiles = ({
  discoveredEntries,
  fileChanges,
  inputFiles,
  normalizePath,
}: {
  discoveredEntries: DiscoveredEntriesLike;
  fileChanges: FileChanges;
  inputFiles: string[];
  normalizePath: (path: string) => string;
}) => {
  const relevantFiles = getRelevantFiles({
    discoveredEntries,
    inputFiles,
    normalizePath,
  });
  return unique(fileChanges.modifiedFiles).filter((file) =>
    relevantFiles.has(file)
  );
};

const collectHotRebuildSnapshots = async ({
  changedFiles,
  readSnapshot,
  sourceSnapshots,
}: {
  changedFiles: string[];
  readSnapshot: (file: string) => Promise<SourceSnapshot>;
  sourceSnapshots: Map<string, SourceSnapshot>;
}) => {
  const snapshots = new Map<string, SourceSnapshot>();
  for (const file of changedFiles) {
    if (
      !(await snapshotChangedFile({
        file,
        nextSnapshots: snapshots,
        readSnapshot,
        sourceSnapshots,
      }))
    ) {
      return;
    }
  }
  return snapshots;
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
  discoveredEntries,
  fileChanges,
  inputFiles,
  normalizePath = defaultNormalizePath,
  parentHasChild,
  readSnapshot,
  sourceSnapshots,
}: {
  discoveredEntries: DiscoveredEntriesLike;
  fileChanges: FileChanges;
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
  const prunedAddedFiles = await pruneStaleAddedFiles({
    addedFiles: fileChanges.addedFiles,
    readSnapshot,
    sourceSnapshots,
  });
  const normalizedFileChanges = {
    ...fileChanges,
    addedFiles: prunedAddedFiles.addedFiles,
  };

  if (
    removedFilesRequireFullRebuild({
      discoveredEntries,
      inputFiles,
      normalizePath,
      removedFiles: normalizedFileChanges.removedFiles,
    }) ||
    (await addedFilesRequireFullRebuild({
      addedFiles: normalizedFileChanges.addedFiles,
      readSnapshot,
    })) ||
    (await modifiedFilesRequireFullRebuild({
      modifiedFiles: normalizedFileChanges.modifiedFiles,
      readSnapshot,
      sourceSnapshots,
    }))
  ) {
    return { kind: 'full' };
  }

  const changedRelevantFiles = getChangedRelevantFiles({
    discoveredEntries,
    fileChanges: normalizedFileChanges,
    inputFiles,
    normalizePath,
  });
  if (changedRelevantFiles.length === 0) {
    return prunedAddedFiles.snapshots.size > 0
      ? { kind: 'none', snapshots: prunedAddedFiles.snapshots }
      : { kind: 'none' };
  }

  try {
    const snapshots = await collectHotRebuildSnapshots({
      changedFiles: changedRelevantFiles,
      readSnapshot,
      sourceSnapshots,
    });
    if (!snapshots) {
      return { kind: 'full' };
    }
    return workflowEntryFilesChanged({
      changedFiles: changedRelevantFiles,
      discoveredEntries,
      normalizePath,
      parentHasChild,
    })
      ? {
          kind: 'hot',
          refreshStepRegistrations: stepRegistrationsNeedRefresh({
            changedFiles: changedRelevantFiles,
            discoveredEntries,
            normalizePath,
          }),
          snapshots,
        }
      : { kind: 'none', snapshots };
  } catch {
    return { kind: 'full' };
  }
};
