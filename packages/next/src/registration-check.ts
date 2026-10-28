import type { Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

/**
 * Workflow IDs as the `"use workflow"` transform stamps them into application
 * code: `order.workflowId = "workflow//./workflows/order//order"`. `start()`
 * reads exactly that property, so an assignment in the server output is proof
 * this deployment can ask for that workflow by name.
 *
 * Anchored on the assignment rather than matching any `workflow//…` literal,
 * because the shipped server bundles are not comment-stripped and the SDK's
 * own JSDoc quotes example ids (`@param name - … "workflow//mypackage@1.0.0//
 * processOrder"`). A bare-literal scan reported those as references to
 * workflows nobody wrote. Escapes and newlines end a match, so a mangled or
 * concatenated string never yields half an id.
 *
 * A transform that stops emitting this shape costs the check coverage, never
 * correctness: a reference it fails to see is a finding it does not make.
 */
const WORKFLOW_ID_ASSIGNMENT_PATTERNS = [
  /\.workflowId\s*=\s*"(workflow\/\/[^"\\\n]+)"/g,
  /\.workflowId\s*=\s*'(workflow\/\/[^'\\\n]+)'/g,
];

const SCANNED_OUTPUT_EXTENSIONS = ['.js', '.mjs', '.cjs'];

/**
 * Thrown when the build registered fewer workflows than the app can start.
 *
 * Declared here rather than taken from `@workflow/errors`: this package is
 * CommonJS, because plenty of apps still write `next.config.js` that way, and
 * `@workflow/errors` is ESM-only. Reaching it would mean the dynamic-import
 * dance `builder-eager.ts` does for `@workflow/builders`, which is more
 * machinery than one error class is worth.
 */
export class WorkflowRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowRegistrationError';
  }
}

/** A workflow the app can start that this build did not register. */
export interface UnregisteredWorkflow {
  workflowId: string;
  /** Server-output files naming the id, relative to the scanned directory. */
  files: string[];
}

export interface RegistrationCheckOptions {
  /** `manifest.json`, as written by the workflow build. */
  manifestPath: string;
  /** The framework's server output directory, e.g. `<distDir>/server`. */
  serverDir: string;
  /**
   * Ignore output files last modified before this timestamp.
   *
   * A build writes into whatever output directory was already there, so a
   * chunk left behind by an earlier build can still name a workflow the
   * current one no longer has. Comparing against the start of this build
   * keeps those out of the comparison. Skipping a file can only ever hide a
   * finding, never invent one, which is the right direction for a check that
   * fails builds.
   */
  writtenAfter?: number;
}

interface ManifestShape {
  workflows?: Record<string, Record<string, { workflowId?: unknown }>>;
}

/**
 * Every workflow id the build registered, read back from the manifest it
 * wrote. Returns `undefined` when there is no manifest to compare against:
 * the workflow build did not run, or what it left behind cannot be read, and
 * neither is something to invent a build failure from here. A manifest that
 * could not be written already fails the build where it is created.
 */
export async function readRegisteredWorkflowIds(
  manifestPath: string
): Promise<Set<string> | undefined> {
  let manifest: ManifestShape;
  try {
    manifest = JSON.parse(
      await readFile(manifestPath, 'utf-8')
    ) as ManifestShape;
  } catch {
    return undefined;
  }

  const registered = new Set<string>();
  for (const entries of Object.values(manifest.workflows ?? {})) {
    for (const entry of Object.values(entries)) {
      if (typeof entry?.workflowId === 'string') {
        registered.add(entry.workflowId);
      }
    }
  }
  return registered;
}

async function* walkOutputFiles(
  directory: string,
  writtenAfter: number | undefined
): AsyncGenerator<string> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* walkOutputFiles(entryPath, writtenAfter);
      continue;
    }
    if (!SCANNED_OUTPUT_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      continue;
    }
    if (writtenAfter !== undefined) {
      try {
        if ((await stat(entryPath)).mtimeMs < writtenAfter) {
          continue;
        }
      } catch {
        continue;
      }
    }
    yield entryPath;
  }
}

/** Every workflow id assigned in one output file. */
function readWorkflowIdsFromOutput(contents: string): Set<string> {
  const workflowIds = new Set<string>();
  if (!contents.includes('workflowId')) {
    return workflowIds;
  }

  for (const pattern of WORKFLOW_ID_ASSIGNMENT_PATTERNS) {
    // Module-level and stateful (`g`), so reset before reuse across files.
    pattern.lastIndex = 0;
    for (const match of contents.matchAll(pattern)) {
      workflowIds.add(match[1]);
    }
  }
  return workflowIds;
}

/**
 * Workflow ids named by the server output, mapped to the files naming them.
 */
export async function collectReferencedWorkflowIds({
  serverDir,
  writtenAfter,
}: Pick<RegistrationCheckOptions, 'serverDir' | 'writtenAfter'>): Promise<
  Map<string, string[]>
> {
  const referenced = new Map<string, string[]>();

  for await (const filePath of walkOutputFiles(serverDir, writtenAfter)) {
    let contents: string;
    try {
      contents = await readFile(filePath, 'utf-8');
    } catch {
      continue;
    }

    const displayPath = relative(serverDir, filePath).replace(/\\/g, '/');
    for (const workflowId of readWorkflowIdsFromOutput(contents)) {
      const files = referenced.get(workflowId);
      if (files) {
        files.push(displayPath);
      } else {
        referenced.set(workflowId, [displayPath]);
      }
    }
  }

  return referenced;
}

/**
 * Workflows the built application can start but this build never registered.
 *
 * The two sets come from the same compiler: the ids in the server output are
 * what the `"use workflow"` transform gave application code, and the manifest
 * is what the flow bundle registered. Anything in the first and not the second
 * is a run that would fail with `WorkflowNotRegisteredError`, which is why
 * this is worth a build failure rather than a log line.
 */
export async function findUnregisteredWorkflows({
  manifestPath,
  serverDir,
  writtenAfter,
}: RegistrationCheckOptions): Promise<UnregisteredWorkflow[]> {
  const registered = await readRegisteredWorkflowIds(manifestPath);
  if (!registered) {
    return [];
  }

  const referenced = await collectReferencedWorkflowIds({
    serverDir,
    writtenAfter,
  });

  return [...referenced]
    .filter(([workflowId]) => !registered.has(workflowId))
    .map(([workflowId, files]) => ({ workflowId, files: files.sort() }))
    .sort((left, right) => left.workflowId.localeCompare(right.workflowId));
}

/**
 * How many findings the message lists. One unreachable file can hold dozens of
 * workflows, and they all share a cause, so the list is there to identify the
 * file rather than to be read end to end.
 */
const MAX_REPORTED_WORKFLOWS = 10;

/** The build-failure message for what {@link findUnregisteredWorkflows} found. */
export function formatUnregisteredWorkflows(
  unregistered: UnregisteredWorkflow[]
): string {
  const describe = ({ workflowId, files }: UnregisteredWorkflow) =>
    `  ${workflowId}\n${files.map((file) => `    referenced in ${file}`).join('\n')}`;

  const count = unregistered.length;
  const listed = unregistered.slice(0, MAX_REPORTED_WORKFLOWS);
  const remaining = count - listed.length;

  return (
    `${count} ${count === 1 ? 'workflow is' : 'workflows are'} referenced by this app but not registered in this build:\n\n` +
    `${listed.map(describe).join('\n\n')}\n` +
    (remaining > 0
      ? `\n  …and ${remaining} more ${remaining === 1 ? 'workflow' : 'workflows'}.\n`
      : '') +
    '\nStarting one of these fails at runtime with WorkflowNotRegisteredError.'
  );
}
