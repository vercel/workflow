/**
 * Workflow references read from the manifest the test build already emits.
 *
 * `start()` accepts either an imported workflow function or the metadata
 * object behind it (`{ workflowId }`). Importing the function is the better
 * option when a test can do it, but some tests cannot: the workflow lives in a
 * package the test does not import, the test drives a run by id, or the
 * assertion is about the set of workflows a build produced. The fallback used
 * to be hand-writing the generated id (`workflow//workflows/approval.ts//approvalWorkflow`),
 * which is a compiler-owned string that changes when a file moves.
 *
 * `buildWorkflowTests()` writes the same `manifest.json` every other Workflow
 * builder writes into the test output directory, and these helpers read it.
 */

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Filename `BaseBuilder.createManifest()` writes into the output directory. */
export const MANIFEST_FILENAME = 'manifest.json';

/**
 * A workflow in the test build, in the shape `start()` accepts.
 *
 * @example
 * ```ts
 * const run = await start(getWorkflowRef("approvalWorkflow"), ["doc-1"]);
 * ```
 */
export interface WorkflowRef {
  /** Exported name of the workflow function. */
  name: string;
  /** Project-relative path of the file it was compiled from. */
  file: string;
  /** Generated workflow id, the field `start()` reads. */
  workflowId: string;
}

type ManifestShape = {
  workflows?: {
    [file: string]: {
      [name: string]: { workflowId?: string };
    };
  };
};

function flattenManifest(manifest: ManifestShape): WorkflowRef[] {
  const refs: WorkflowRef[] = [];
  for (const [file, entries] of Object.entries(manifest.workflows ?? {})) {
    for (const [name, entry] of Object.entries(entries ?? {})) {
      if (entry?.workflowId) {
        refs.push({ name, file, workflowId: entry.workflowId });
      }
    }
  }
  return refs.sort(
    (a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name)
  );
}

// Keyed on the manifest's mtime so a watch-mode rebuild is picked up: the
// worker process outlives the build that wrote the file it read.
const cache = new Map<string, { mtimeMs: number; refs: WorkflowRef[] }>();

/** Drop the parsed-manifest cache. Exported for tests. */
export function clearWorkflowRefCache(): void {
  cache.clear();
}

/**
 * Read every workflow in the test build from `<outDir>/manifest.json`.
 */
export function readWorkflowRefs(outDir: string): WorkflowRef[] {
  const manifestPath = join(outDir, MANIFEST_FILENAME);
  let mtimeMs: number | undefined;
  try {
    mtimeMs = statSync(manifestPath).mtimeMs;
  } catch {
    // Fall through to the read below, which reports the missing manifest.
  }

  const cached = cache.get(manifestPath);
  if (cached && mtimeMs !== undefined && cached.mtimeMs === mtimeMs) {
    return cached.refs;
  }

  let contents: string;
  try {
    contents = readFileSync(manifestPath, 'utf8');
  } catch {
    throw new Error(
      `Workflow test manifest not found at ${manifestPath}. ` +
        'Workflow references are read from the manifest written by the test build, so ' +
        'the workflow() Vitest plugin (or buildWorkflowTests() in globalSetup) has to run first.'
    );
  }

  let parsed: ManifestShape;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error(
      `Workflow test manifest at ${manifestPath} is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  const refs = flattenManifest(parsed);
  if (mtimeMs !== undefined) cache.set(manifestPath, { mtimeMs, refs });
  return refs;
}

function formatQualifiedName(ref: WorkflowRef): string {
  return `${ref.file}#${ref.name}`;
}

function formatCandidates(refs: WorkflowRef[], limit = 20): string {
  const shown = refs.slice(0, limit).map(formatQualifiedName);
  const remaining = refs.length - shown.length;
  if (remaining > 0) shown.push(`…and ${remaining} more`);
  return shown.length > 0 ? shown.join(', ') : '(none)';
}

/**
 * Find one workflow among `refs`.
 *
 * `query` is either an exported workflow name (`"approvalWorkflow"`) or a
 * file-qualified name (`"workflows/approval.ts#approvalWorkflow"`). The file
 * part matches by path suffix, so `"approval.ts#approvalWorkflow"` also works.
 *
 * Pure, so the matching rules can be tested without a build.
 */
export function selectWorkflowRef(
  refs: WorkflowRef[],
  query: string
): WorkflowRef {
  const separator = query.lastIndexOf('#');
  const name = separator === -1 ? query : query.slice(separator + 1);
  const file = separator === -1 ? undefined : query.slice(0, separator);

  let matches = refs.filter((ref) => ref.name === name);
  if (file !== undefined) {
    const normalized = file.replace(/^\.\//, '');
    // An exact path always wins. A suffix is a convenience for the common
    // case, but on its own it would make the full manifest path — the one the
    // ambiguity error tells you to use — ambiguous again whenever a shorter
    // path is a suffix of a longer one.
    const exact = matches.filter((ref) => ref.file === normalized);
    matches =
      exact.length > 0
        ? exact
        : matches.filter((ref) => ref.file.endsWith(`/${normalized}`));
  }

  if (matches.length === 1) return matches[0];

  if (matches.length === 0) {
    // Alphabetical order buries the likely intent once a project has more
    // workflows than the list shows, so lead with near misses on the name.
    const needle = name.toLowerCase();
    const suggestions = refs.filter((ref) => {
      const candidate = ref.name.toLowerCase();
      return candidate.includes(needle) || needle.includes(candidate);
    });
    const didYouMean =
      suggestions.length > 0
        ? ` Did you mean: ${formatCandidates(suggestions, 5)}?`
        : '';

    throw new Error(
      `No workflow matching "${query}" was found in the test build.${didYouMean} ` +
        `Workflows in this build: ${formatCandidates(refs)}.`
    );
  }

  throw new Error(
    `"${query}" matches ${matches.length} workflows in the test build: ` +
      `${formatCandidates(matches)}. ` +
      'Pass a file-qualified name, for example getWorkflowRef("' +
      `${formatQualifiedName(matches[0])}").`
  );
}
