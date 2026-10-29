import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { WorkflowManifest } from './apply-swc-transform.js';

/**
 * The workflow IDs a framework's app-code transform stamped into the modules
 * it compiled — in other words, the workflows `start()` can name at runtime.
 *
 * This is the other half of the registration picture. `createManifest()`
 * records what the flow bundle *registered*; this records what the application
 * can *ask for*. Discovery decides the first and the host bundler decides the
 * second, and the two disagree whenever discovery cannot follow an import the
 * bundler can (a computed `import()`, a specifier its resolver rejects). The
 * disagreement is invisible until a run fails with
 * `WorkflowNotRegisteredError`, so builds compare the two sets.
 *
 * ## Why a sidecar rather than a scan of the build output
 *
 * The IDs are also present in the emitted bundles, as
 * `order.workflowId = "workflow//…"`. Reading them back out of there means
 * pattern-matching minified JavaScript, and a build gate cannot afford what
 * that costs: shipped bundles are not comment-stripped, so documentation and
 * code-generation templates that quote the emit shape read as references to
 * workflows nobody wrote. Recording them here instead keeps the data in the
 * form the compiler produced it, where a comment cannot forge an entry.
 *
 * ## Why entries can only ever be missing, never wrong
 *
 * {@link resetWorkflowAppGraph} empties the directory before a build compiles
 * anything, so an entry exists only if the transform ran on that module during
 * *this* build. A bundler that serves a module from its loader cache skips the
 * transform and contributes nothing, which costs the comparison coverage and
 * can never invent a workflow the app does not have. For a check that fails
 * builds, that is the only acceptable direction to be wrong in.
 */
const APP_GRAPH_ENTRY_SUFFIX = '.json';

/**
 * Matches the manifest the SWC plugin appends to every module it transforms.
 * A fixed sentinel in the transform's own output, read back by the same
 * process that produced it — parsing a known format, not searching code.
 */
const WORKFLOW_MANIFEST_COMMENT = /\/\*\*__internal_workflows({.*?})\*\//s;

/** One module's contribution to the app graph. */
export interface WorkflowAppGraphEntry {
  /** Absolute path of the transformed module. */
  file: string;
  /** Workflow IDs the transform stamped into it. */
  workflowIds: string[];
}

/**
 * Read the workflow manifest the SWC plugin embedded in transformed output.
 * Returns an empty manifest when the module declared nothing, which is the
 * overwhelmingly common case.
 */
export function extractWorkflowManifestComment(code: string): WorkflowManifest {
  const match = code.match(WORKFLOW_MANIFEST_COMMENT);
  if (!match?.[1]) {
    return {};
  }

  try {
    return (JSON.parse(match[1]) as WorkflowManifest) ?? {};
  } catch {
    return {};
  }
}

/** The workflow IDs in a manifest, flattened across files and function names. */
export function getManifestWorkflowIds(
  manifest: WorkflowManifest | undefined
): string[] {
  const workflowIds: string[] = [];
  for (const entries of Object.values(manifest?.workflows ?? {})) {
    for (const entry of Object.values(entries)) {
      if (typeof entry?.workflowId === 'string') {
        workflowIds.push(entry.workflowId);
      }
    }
  }
  return workflowIds;
}

/**
 * Drop everything recorded for a previous build. Called once before the host
 * framework compiles, so what remains afterwards describes this build alone.
 */
export async function resetWorkflowAppGraph(
  appGraphDir: string
): Promise<void> {
  await rm(appGraphDir, { recursive: true, force: true });
  await mkdir(appGraphDir, { recursive: true });
}

/**
 * Record what one module's transform produced.
 *
 * One file per module, named by a digest of the module path: transforms run
 * across worker threads and processes, and appending to a shared file from
 * several of them at once loses writes. A module transformed twice in one
 * build simply rewrites its own entry.
 */
export async function recordWorkflowAppGraphEntry({
  appGraphDir,
  file,
  manifest,
}: {
  appGraphDir: string;
  file: string;
  manifest: WorkflowManifest;
}): Promise<void> {
  const workflowIds = getManifestWorkflowIds(manifest);
  if (workflowIds.length === 0) {
    return;
  }

  const entry: WorkflowAppGraphEntry = { file, workflowIds };
  const name = createHash('sha256').update(file).digest('hex').slice(0, 32);
  try {
    await mkdir(appGraphDir, { recursive: true });
    await writeFile(
      join(appGraphDir, `${name}${APP_GRAPH_ENTRY_SUFFIX}`),
      JSON.stringify(entry),
      'utf-8'
    );
  } catch {
    // Recording is best-effort. A build must not fail because a diagnostic
    // sidecar could not be written; the comparison degrades to covering the
    // modules it did receive.
  }
}

/**
 * Every workflow ID recorded for this build, mapped to the modules that
 * declared it.
 */
export async function readWorkflowAppGraph(
  appGraphDir: string
): Promise<Map<string, string[]>> {
  const appGraph = new Map<string, string[]>();

  let names: string[];
  try {
    names = await readdir(appGraphDir);
  } catch {
    return appGraph;
  }

  for (const name of names) {
    if (!name.endsWith(APP_GRAPH_ENTRY_SUFFIX)) {
      continue;
    }

    let entry: WorkflowAppGraphEntry;
    try {
      entry = JSON.parse(
        await readFile(join(appGraphDir, name), 'utf-8')
      ) as WorkflowAppGraphEntry;
    } catch {
      continue;
    }
    if (!Array.isArray(entry?.workflowIds) || typeof entry.file !== 'string') {
      continue;
    }

    for (const workflowId of entry.workflowIds) {
      const files = appGraph.get(workflowId);
      if (files) {
        files.push(entry.file);
      } else {
        appGraph.set(workflowId, [entry.file]);
      }
    }
  }

  return appGraph;
}

/** A workflow the application can start that the build did not register. */
export interface UnregisteredWorkflow {
  workflowId: string;
  /** Modules declaring it, as a build log should show them. */
  files: string[];
}

/**
 * Workflows the compiled application can start but this build never
 * registered.
 *
 * Both sides come from the same compiler: the app graph is what the app-code
 * transform stamped in for `start()` to use, the manifest is what the flow
 * bundle registered. Anything in the first and not the second is a run
 * guaranteed to fail, which is what makes it worth a build failure rather
 * than a log line.
 */
export function findUnregisteredWorkflows({
  appGraph,
  manifest,
  workingDir,
}: {
  appGraph: Map<string, string[]>;
  /**
   * What the build registered. Required, and deliberately not nullable: a
   * manifest the caller could not read is not an empty one, and treating it
   * as empty would report every workflow in the application. Callers that
   * cannot read it must skip the comparison instead.
   */
  manifest: WorkflowManifest;
  /** Root that reported module paths are made relative to. */
  workingDir?: string;
}): UnregisteredWorkflow[] {
  const registered = new Set(getManifestWorkflowIds(manifest));
  const display = (file: string) => {
    if (!workingDir) {
      return file;
    }
    const relativePath = relative(workingDir, file).replace(/\\/g, '/');
    return relativePath === '' || relativePath.startsWith('../')
      ? file
      : relativePath;
  };

  return [...appGraph]
    .filter(([workflowId]) => !registered.has(workflowId))
    .map(([workflowId, files]) => ({
      workflowId,
      files: [...new Set(files.map(display))].sort(),
    }))
    .sort((left, right) => left.workflowId.localeCompare(right.workflowId));
}

/**
 * How many findings a message lists. One unreachable module can declare dozens
 * of workflows that all share a cause, so the list identifies the module
 * rather than being read end to end.
 */
const MAX_REPORTED_WORKFLOWS = 10;

/** The report for what {@link findUnregisteredWorkflows} found. */
export function formatUnregisteredWorkflows(
  unregistered: UnregisteredWorkflow[]
): string {
  const describe = ({ workflowId, files }: UnregisteredWorkflow) =>
    `  ${workflowId}\n${files.map((file) => `    declared in ${file}`).join('\n')}`;

  const count = unregistered.length;
  const listed = unregistered.slice(0, MAX_REPORTED_WORKFLOWS);
  const remaining = count - listed.length;

  return (
    `${count} ${count === 1 ? 'workflow is' : 'workflows are'} compiled into this app but not registered in this build:\n\n` +
    `${listed.map(describe).join('\n\n')}\n` +
    (remaining > 0
      ? `\n  …and ${remaining} more ${remaining === 1 ? 'workflow' : 'workflows'}.\n`
      : '') +
    '\nStarting one of these fails at runtime with WorkflowNotRegisteredError.'
  );
}
