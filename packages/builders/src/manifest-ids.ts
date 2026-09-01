import { createHash } from 'node:crypto';
import type { WorkflowManifest } from './apply-swc-transform.js';

export interface WorkflowBuildErrorOptions extends ErrorOptions {
  /**
   * An optional actionable hint appended to the main message, explaining how
   * the user can resolve the failure.
   */
  hint?: string;
}

/**
 * Thrown when the workflow build pipeline (esbuild, SWC transform, file
 * discovery, bundler integration) fails in a way the user can act on.
 */
export class WorkflowBuildError extends Error {
  readonly hint?: string;

  constructor(message: string, options?: WorkflowBuildErrorOptions) {
    const body = options?.hint
      ? `${message}\n\nhint: ${options.hint}`
      : message;
    super(body, { cause: options?.cause });
    this.name = 'WorkflowBuildError';
    this.hint = options?.hint;
  }
}

/**
 * Location (and identity fingerprint) of a manifest entry that produced a
 * workflow/step ID during a build. Shared by the duplicate-ID checks in
 * `swc-esbuild-plugin.ts` (esbuild bundling path) and `base-builder.ts`
 * (source registration path).
 */
export type ManifestEntryLocation = {
  filePath: string;
  name: string;
  /**
   * Fingerprint (SHA-256) of the source file contents that produced this
   * entry. Used to recognize equivalent duplicate copies of the same module
   * (see `assertUniqueManifestIds`). `undefined` when the caller cannot
   * provide the source contents, which disables deduplication and preserves
   * the collision error.
   */
  contentHash?: string;
};

/**
 * Hash source file contents for manifest-entry equivalence comparison.
 */
export function hashManifestSource(source: string): string {
  return createHash('sha256').update(source).digest('hex');
}

function formatIdLocation(location: ManifestEntryLocation): string {
  return `${location.filePath}#${location.name}`;
}

function assertUniqueManifestIds<TEntry>(
  entriesByFile: Record<string, Record<string, TEntry>> | undefined,
  ids: Map<string, ManifestEntryLocation>,
  getId: (entry: TEntry) => string,
  label: 'step' | 'workflow',
  contentHash: string | undefined
): void {
  for (const [filePath, entries] of Object.entries(entriesByFile || {})) {
    for (const [name, data] of Object.entries(entries)) {
      const id = getId(data);
      const existing = ids.get(id);
      const current = { filePath, name, contentHash };
      if (
        existing &&
        (existing.filePath !== current.filePath ||
          existing.name !== current.name)
      ) {
        // Two *different* files generated the same ID. If both files have
        // identical contents and the ID belongs to the same symbol, they are
        // duplicate copies of the same logical module rather than a genuine
        // collision. The main producer of such copies is pnpm, which
        // materializes one package version once per peer-dependency
        // resolution (node_modules/.pnpm/pkg@1.0.0_peer-a@.../ and
        // .../pkg@1.0.0_peer-b@.../ hard-link the same store files), while
        // the canonical ID intentionally describes the logical module
        // (`name/subpath@version`) and ignores installation topology.
        // Registering equivalent definitions is harmless — they run the same
        // code under the same ID — so keep the first one and continue.
        if (
          existing.name === current.name &&
          existing.contentHash !== undefined &&
          existing.contentHash === current.contentHash
        ) {
          continue;
        }
        const idName = label === 'step' ? 'workflow step ID' : 'workflow ID';
        const functionName = `${label} function`;
        const capitalizedLabel = label === 'step' ? 'Step' : 'Workflow';
        throw new WorkflowBuildError(
          `Duplicate ${idName} "${id}" generated for ${formatIdLocation(existing)} and ${formatIdLocation(current)}.`,
          {
            hint:
              `${capitalizedLabel} IDs must be unique across a build. ` +
              `If you own one of the colliding files, rename the ${functionName} or export ` +
              `the package file through a unique package subpath. If the collision is in a ` +
              `transitive dependency you don't control, file an issue with the upstream ` +
              `package or pin to a non-colliding version.`,
          }
        );
      }
      ids.set(id, current);
    }
  }
}

/**
 * Merge one file's transform manifest into the build-wide manifest, failing
 * the build on genuine duplicate step/workflow IDs while deduplicating
 * equivalent copies of the same module (e.g. pnpm peer-dependency variants
 * of one package version).
 *
 * @param contentHash - Fingerprint of the source file that produced
 * `incoming` (see {@link hashManifestSource}). Callers merge one file's
 * manifest at a time, so a single hash covers every incoming entry.
 */
export function mergeWorkflowManifest(
  target: WorkflowManifest,
  incoming: WorkflowManifest,
  stepIds: Map<string, ManifestEntryLocation>,
  workflowIds: Map<string, ManifestEntryLocation>,
  contentHash?: string
): void {
  assertUniqueManifestIds(
    incoming.steps,
    stepIds,
    (data) => data.stepId,
    'step',
    contentHash
  );
  assertUniqueManifestIds(
    incoming.workflows,
    workflowIds,
    (data) => data.workflowId,
    'workflow',
    contentHash
  );

  target.workflows = Object.assign(target.workflows || {}, incoming.workflows);
  target.steps = Object.assign(target.steps || {}, incoming.steps);
  target.classes = Object.assign(target.classes || {}, incoming.classes);
}
