import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

export interface DiscoveredEntriesLike {
  discoveredSteps: Set<string>;
  discoveredWorkflows: Set<string>;
  discoveredSerdeFiles: Set<string>;
  discoveredFiles: Set<string>;
}

type ImportGraph = ReadonlyMap<string, ReadonlySet<string>>;

export type ScheduledRebuild =
  | { kind: 'files'; files: string[] }
  | { kind: 'full' };

export interface SourceSnapshot {
  sourceHash: string;
  importSignature: string;
  hasUseWorkflow: boolean;
  hasUseStep: boolean;
  hasSerde: boolean;
}

export type HotRebuildTarget = 'workflows' | 'steps' | 'both';

export type RebuildDecision =
  | { kind: 'skip'; snapshots: Map<string, SourceSnapshot> }
  | {
      kind: 'hot';
      target: HotRebuildTarget;
      snapshots: Map<string, SourceSnapshot>;
    }
  | { kind: 'full' };

export type SourceAnalyzer = (source: string) => {
  hasUseWorkflow: boolean;
  hasUseStep: boolean;
  hasSerde: boolean;
  importSpecifiers: string[];
};

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

export const createSourceSnapshotFromSource = (
  source: string,
  analyzeWorkflowSource: SourceAnalyzer
): SourceSnapshot => {
  const analysis = analyzeWorkflowSource(source);

  return {
    sourceHash: createHash('sha256').update(source).digest('base64url'),
    importSignature: [...analysis.importSpecifiers].sort().join('\n'),
    hasUseWorkflow: analysis.hasUseWorkflow,
    hasUseStep: analysis.hasUseStep,
    hasSerde: analysis.hasSerde,
  };
};

export const createSourceSnapshot = async ({
  file,
  analyzeWorkflowSource,
}: {
  file: string;
  analyzeWorkflowSource: SourceAnalyzer;
}): Promise<SourceSnapshot> => {
  const contents = await readFile(file);
  if (isSourceFile(file)) {
    return createSourceSnapshotFromSource(
      contents.toString('utf8'),
      analyzeWorkflowSource
    );
  }
  return {
    sourceHash: createHash('sha256').update(contents).digest('base64url'),
    importSignature: '',
    hasUseWorkflow: false,
    hasUseStep: false,
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

export const getAffectedWorkflowFiles = ({
  discoveredEntries,
  importGraph,
  normalizePath = defaultNormalizePath,
}: {
  discoveredEntries: DiscoveredEntriesLike;
  importGraph: ImportGraph;
  normalizePath?: (path: string) => string;
}) => {
  const affectedFiles = new Set(
    [...discoveredEntries.discoveredWorkflows].map(normalizePath)
  );
  const pendingFiles = [...affectedFiles];

  for (let index = 0; index < pendingFiles.length; index++) {
    const file = pendingFiles[index];
    for (const child of importGraph.get(file) ?? []) {
      const normalizedChild = normalizePath(child);
      if (affectedFiles.has(normalizedChild)) {
        continue;
      }
      affectedFiles.add(normalizedChild);
      pendingFiles.push(normalizedChild);
    }
  }

  return affectedFiles;
};

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
}): Promise<Map<string, SourceSnapshot>> => {
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
) =>
  previousSnapshot.importSignature !== nextSnapshot.importSignature ||
  previousSnapshot.hasUseWorkflow !== nextSnapshot.hasUseWorkflow ||
  previousSnapshot.hasUseStep !== nextSnapshot.hasUseStep ||
  previousSnapshot.hasSerde !== nextSnapshot.hasSerde;

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
        if (pending?.kind !== 'full') {
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

const getHotRebuildTarget = ({
  affectedWorkflowFiles,
  changedFiles,
  discoveredEntries,
  normalizePath,
}: {
  affectedWorkflowFiles: ReadonlySet<string>;
  changedFiles: string[];
  discoveredEntries: DiscoveredEntriesLike;
  normalizePath: (path: string) => string;
}): HotRebuildTarget | undefined => {
  const stepEntryFiles = new Set(
    [...discoveredEntries.discoveredSteps].map(normalizePath)
  );
  const serdeFiles = new Set(
    [...discoveredEntries.discoveredSerdeFiles].map(normalizePath)
  );
  let rebuildWorkflows = false;
  let rebuildSteps = false;

  for (const changedFile of changedFiles) {
    if (serdeFiles.has(changedFile)) {
      rebuildWorkflows = true;
      rebuildSteps = true;
      continue;
    }
    if (affectedWorkflowFiles.has(changedFile)) {
      rebuildWorkflows = true;
    }
    if (stepEntryFiles.has(changedFile)) {
      rebuildSteps = true;
    }
  }

  if (rebuildWorkflows && rebuildSteps) {
    return 'both';
  }
  if (rebuildWorkflows) {
    return 'workflows';
  }
  if (rebuildSteps) {
    return 'steps';
  }
};

export const classifyRebuild = async ({
  affectedWorkflowFiles,
  files,
  discoveredEntries,
  inputFiles,
  normalizePath = defaultNormalizePath,
  readSnapshot,
  sourceSnapshots,
}: {
  affectedWorkflowFiles: ReadonlySet<string>;
  files: string[];
  discoveredEntries: DiscoveredEntriesLike;
  inputFiles: string[];
  normalizePath?: (path: string) => string;
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
        nextSnapshot.hasUseWorkflow ||
        nextSnapshot.hasUseStep ||
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
      continue;
    }
    snapshots.set(file, nextSnapshot);
  }

  const changedFiles = [...snapshots.keys()];
  const target = getHotRebuildTarget({
    affectedWorkflowFiles,
    changedFiles,
    discoveredEntries,
    normalizePath,
  });
  return target
    ? { kind: 'hot', target, snapshots }
    : { kind: 'skip', snapshots };
};
