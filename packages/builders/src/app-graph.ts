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
 * Where the app-code transform records what it stamped in, and the manifest to
 * compare those records against.
 *
 * Both travel through the environment rather than through plugin options,
 * because the two halves are produced in places that cannot hand values to
 * each other: the transform runs inside the host bundler — for SvelteKit in
 * worker threads that re-evaluate the config from scratch — and the manifest is
 * written by whichever builder the integration happens to run, at a point that
 * differs per framework. Worker threads and child processes inherit
 * `process.env`, which is the channel the SWC plugin cache already uses.
 *
 * An unset directory means no production build armed the check, so nothing is
 * recorded and the comparison has nothing to say.
 */
export const APP_GRAPH_DIR_ENV = 'WORKFLOW_PRIVATE_APP_GRAPH_DIR';
export const APP_GRAPH_MANIFEST_ENV = 'WORKFLOW_PRIVATE_APP_GRAPH_MANIFEST';

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

/**
 * Thrown when a build registered fewer workflows than the app can start.
 *
 * Not `WorkflowBuildError` from `@workflow/errors`, because `@workflow/next`
 * consumes this too and that package is CommonJS while `@workflow/errors` is
 * ESM-only. One error class is not worth the dynamic-import dance
 * `builder-eager.ts` does for the rest of this package.
 */
export class WorkflowRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowRegistrationError';
  }
}

export type RegistrationCheckMode = 'error' | 'warn' | 'off';

/**
 * What a production build does about a workflow the app can start but this
 * build did not register.
 *
 * Defaults to failing. The configuration it reports already fails every run of
 * that workflow, and a warning inside a build that reports success is exactly
 * how such a configuration ships unnoticed.
 */
export function resolveRegistrationCheckMode(
  env: NodeJS.ProcessEnv = process.env
): RegistrationCheckMode {
  switch (env.WORKFLOW_REGISTRATION_CHECK?.toLowerCase()) {
    case 'off':
    case '0':
    case 'false':
      return 'off';
    case 'warn':
      return 'warn';
    case 'error':
    case '1':
    case 'true':
      return 'error';
    default:
      // Dependency discovery is opt-out, and opting out means deliberately
      // leaving a dependency's workflows unregistered while the host bundler
      // still compiles them. Failing the build over the consequence of a flag
      // the app set would be the check arguing with its own configuration, so
      // it reports and lets the build through.
      return isNodeModulesDiscoveryDisabled(env) ? 'warn' : 'error';
  }
}

function isNodeModulesDiscoveryDisabled(env: NodeJS.ProcessEnv): boolean {
  const value = env.WORKFLOW_DISCOVER_NODE_MODULES?.toLowerCase();
  return value === '0' || value === 'false';
}

/** Guidance appended to a failure, naming the usual cause and the way out. */
export const REGISTRATION_FAILURE_GUIDANCE =
  'Workflow discovery walks the import graph from your app entrypoints and only follows literal\n' +
  'string specifiers, so this usually means it could not reach the file: check that every import on\n' +
  'the way to the workflow is a literal specifier, and look for earlier warnings about imports that\n' +
  'could not be resolved.\n' +
  'Set WORKFLOW_REGISTRATION_CHECK=warn to report this without failing the build.';

/**
 * The default place to record an app graph: beside the other build caches the
 * integrations keep, under the app being built.
 *
 * Frameworks that own a single build-output directory can pass their own path
 * instead — `@workflow/next` records inside `distDir` so the records are
 * cleaned with the build. The Rollup-based integrations have no one equivalent
 * (Nitro's `buildDir`, Astro's `outDir`, SvelteKit's `.svelte-kit`), so they
 * share this one.
 */
export function resolveAppGraphDir(workingDir = process.cwd()): string {
  return join(workingDir, 'node_modules/.cache/workflow/app-graph');
}

/**
 * Begin recording the app graph for a production build, discarding whatever an
 * earlier build left behind.
 *
 * Idempotent per process and per directory, so the several compiler passes a
 * framework runs — and the worker threads SvelteKit spawns, which inherit the
 * armed environment — add to one set of records instead of wiping each other's.
 * Development builds arm nothing: there is no compile to check, and an import
 * written before the file it points at is a normal editing state there.
 */
export async function armWorkflowAppGraph({
  appGraphDir,
  isDevelopment = process.env.NODE_ENV === 'development',
}: {
  appGraphDir: string;
  isDevelopment?: boolean;
}): Promise<void> {
  if (isDevelopment || process.env[APP_GRAPH_DIR_ENV] === appGraphDir) {
    return;
  }

  await resetWorkflowAppGraph(appGraphDir);
  process.env[APP_GRAPH_DIR_ENV] = appGraphDir;
}

/**
 * Record what one module's transform produced, into whatever directory the
 * build armed. A no-op when nothing armed one.
 */
export async function recordTransformedWorkflows({
  file,
  code,
}: {
  file: string;
  code: string;
}): Promise<void> {
  const appGraphDir = process.env[APP_GRAPH_DIR_ENV];
  if (!appGraphDir) {
    return;
  }

  const manifest = extractWorkflowManifestComment(code);
  if (!manifest.workflows) {
    return;
  }

  await recordWorkflowAppGraphEntry({ appGraphDir, file, manifest });
}

/**
 * Compare what the app can start against what the build registered, and report
 * the difference.
 *
 * Safe to call more than once in a build, and at any point after the host
 * bundler has compiled: a partial app graph can only yield a subset of the
 * findings a complete one would, never a finding a complete one would not. So
 * an integration whose framework compiles in several passes may run this at
 * the end of each, and the last one sees the whole picture.
 */
export async function assertWorkflowsAreRegistered({
  workingDir,
  manifestPath = process.env[APP_GRAPH_MANIFEST_ENV],
  reportedWorkflowIds,
}: {
  /** Root that reported module paths are made relative to. */
  workingDir?: string;
  /** Defaults to the manifest the build published. */
  manifestPath?: string;
  /**
   * Workflow IDs already reported in this process, so a framework that calls
   * this once per compiler pass does not repeat itself. Mutated in place.
   */
  reportedWorkflowIds?: Set<string>;
} = {}): Promise<void> {
  const mode = resolveRegistrationCheckMode();
  const appGraphDir = process.env[APP_GRAPH_DIR_ENV];
  if (mode === 'off' || !appGraphDir || !manifestPath) {
    return;
  }

  // Nothing recorded means no module reported a workflow this build — a
  // bundler that served everything from its caches looks the same as an app
  // with no workflows, and neither is something to fail over.
  const appGraph = await readWorkflowAppGraph(appGraphDir);
  if (appGraph.size === 0) {
    return;
  }

  // An unreadable manifest is not an empty one: comparing against it would
  // report every workflow in the app. A manifest that could not be written
  // already fails the build where it is created.
  let manifest: WorkflowManifest;
  try {
    manifest = JSON.parse(
      await readFile(manifestPath, 'utf-8')
    ) as WorkflowManifest;
  } catch {
    return;
  }

  let unregistered = findUnregisteredWorkflows({
    appGraph,
    manifest,
    workingDir,
  });
  if (reportedWorkflowIds) {
    unregistered = unregistered.filter(
      ({ workflowId }) => !reportedWorkflowIds.has(workflowId)
    );
    for (const { workflowId } of unregistered) {
      reportedWorkflowIds.add(workflowId);
    }
  }
  if (unregistered.length === 0) {
    return;
  }

  const message = formatUnregisteredWorkflows(unregistered);
  if (mode === 'warn') {
    console.warn(`\n⚠ Warning: ${message}\n`);
    return;
  }

  throw new WorkflowRegistrationError(
    `${message}\n\n${REGISTRATION_FAILURE_GUIDANCE}`
  );
}
