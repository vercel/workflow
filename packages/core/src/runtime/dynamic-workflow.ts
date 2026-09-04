/**
 * Dynamic workflow source: starting a run from a workflow function that is
 * not in the deployment's build-time manifest.
 *
 * The normal path compiles workflow functions at build time — the SWC plugin
 * rewrites `"use workflow"` bodies, the builder bundles them, and `start()`
 * names one by the `workflowId` the transform stamped on it. Dynamic source
 * covers the cases where the shape of the orchestration is only known after
 * the deployment exists: a workflow-builder UI, a customer-defined automation,
 * an LLM-generated plan over a fixed catalog of steps.
 *
 * This module owns the compile half of that: validating the source, deriving
 * a stable workflow id from it, and generating the VM code that registers it.
 * The generated code — not the source — is what gets stored with the run and
 * replayed, so the module is also the format boundary: a run replays byte-for-byte
 * the code it started on, and changing the generator here does not retroactively
 * change what an in-flight run executes.
 *
 * Deliberately not a security sandbox. The workflow VM enforces determinism,
 * not isolation from malicious JavaScript, so dynamic source is trusted
 * application code — reviewed, or generated under constraints the application
 * imposes. The `steps` allowlist below is a convenience that keeps ordinary
 * generated code from reaching a step it was not given; it is not a
 * capability boundary against code that is actively trying to escape one.
 */

import { WorkflowRuntimeError } from '@workflow/errors';
import type { StartOptions } from './start.js';

/**
 * A step exposed to dynamic source.
 *
 * Either an imported step function, or an explicit `{ stepId }` for a step
 * whose function is not importable from the calling context.
 *
 * The function arm is deliberately typed as "any function" rather than as
 * something carrying `stepId`: the build-time transform stamps `.stepId` on
 * step functions at *runtime*, and nothing adds it to their declared type. A
 * type that demanded it would reject the documented call — `steps: { fetchUser,
 * sendEmail }` with real imports — and only accept the escape hatch. The
 * runtime check in `resolveStepId` is the real gate, and it fails with a
 * message naming the alias when a value turns out to carry no step id.
 */
export type DynamicWorkflowStepReference =
  | { readonly stepId: string }
  // biome-ignore lint/suspicious/noExplicitAny: a step of any signature
  | ((...args: any[]) => unknown);

export interface DynamicWorkflowOptions {
  /**
   * Already-registered step functions to expose to the source, keyed by the
   * alias it calls them under (`steps.<alias>(...)`).
   *
   * Each value is either an imported step function — the SDK transform stamps
   * a `.stepId` on it — or an explicit `{ stepId }` reference for a step whose
   * function is not importable from the calling context.
   *
   * There is no way to register a *new* step from dynamic source: only the
   * orchestration is dynamic, and every step it can reach was deployed with
   * the app.
   */
  steps: Record<string, DynamicWorkflowStepReference>;

  /**
   * Name of the async workflow function in the source. Defaults to
   * `"workflow"`.
   */
  exportName?: string;
}

/** `start()` options for the dynamic-source overload. */
export type DynamicStartOptions = StartOptions & {
  dynamic: DynamicWorkflowOptions;
};

/**
 * Plaintext metadata recorded on `executionContext.dynamicWorkflow`.
 *
 * Deliberately small and non-sensitive: it has to fit the execution-context
 * budget (2 KB on `world-vercel`) and it is readable without decrypting
 * anything, which is what lets observability show that a run is dynamic —
 * and which steps it was allowed to call — while the code itself stays
 * encrypted behind the run's ref.
 */
export interface DynamicWorkflowMetadata {
  version: 1;
  /** SHA-256 over the source and its step bindings. */
  sourceHash: string;
  /** Name of the workflow function inside the source. */
  exportName: string;
  /** Alias → step id map the source was compiled against. */
  steps: Record<string, string>;
}

/**
 * Maximum size of the *source* `start()` accepts.
 *
 * This is a product limit rather than a storage one — generated
 * orchestration functions are small, and a caller handing us a megabyte of
 * "workflow" has almost certainly made a mistake worth surfacing at the call
 * site. The storage layer's own cap is far higher; see the Dynamic Workflows
 * docs.
 */
export const DYNAMIC_WORKFLOW_SOURCE_MAX_BYTES = 128 * 1024;

/**
 * Largest serialized code payload sent inline on `run_created`.
 *
 * Above this the code is uploaded separately and referenced, because it stops
 * fitting comfortably in the creating write's metadata budget (the
 * `world-vercel` backend caps the inline field at 32 KB). Set below that cap
 * so a compression ratio worse than expected does not push a run over it.
 *
 * Almost every real definition is under this: 24 KB of *compressed,
 * encrypted* bytes is a lot of JavaScript.
 */
export const DYNAMIC_WORKFLOW_CODE_INLINE_MAX_BYTES = 24 * 1024;

const SAFE_DYNAMIC_IDENTIFIER = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;

/**
 * Rejects module syntax, which the generated wrapper cannot host: the code is
 * evaluated as a script in the workflow VM, so an `import` or `export` in it
 * is a syntax error at replay time rather than at `start()` time. Catching it
 * here turns a run that can never execute into a failed call.
 *
 * Anchored to the start of a line, which is where module syntax lives in any
 * formatted source. Matching it anywhere would reject a `steps.notify("…
 * import …")` whose *string* happens to contain the word — a false positive
 * that costs a caller a working workflow, which is much worse than the
 * remaining false negative (an `import` indented behind other code on one
 * line, which still fails loudly at replay).
 *
 * Intentionally a regex and not a parser. The MVP's contract is "one async
 * function, no modules", which is cheap to check conservatively; a real parser
 * is the right answer once the accepted surface grows past that (see the open
 * questions on the RFC).
 */
const UNSUPPORTED_DYNAMIC_MODULE_SYNTAX =
  /^[ \t]*(?:import\s*(?:[\w*{]|\(|['"])|export\s+(?:async\s+)?(?:function|const|let|var|class|default|\{|\*))/m;

function assertDynamicWorkflowIdentifier(kind: string, value: string): void {
  if (!SAFE_DYNAMIC_IDENTIFIER.test(value)) {
    throw new WorkflowRuntimeError(
      `Invalid dynamic workflow ${kind} ${JSON.stringify(value)}. Use a valid JavaScript identifier: letters, digits, "_" and "$", not starting with a digit.`
    );
  }
}

/**
 * Stable stringify for the hash input. `JSON.stringify` on an object is
 * insertion-ordered, so two callers passing the same steps in a different
 * order would otherwise hash differently and produce two workflow ids for
 * one workflow.
 */
function stableJsonStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJsonStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, val]) => `${JSON.stringify(key)}:${stableJsonStringify(val)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

async function sha256Hex(input: string): Promise<string> {
  // Web Crypto rather than `node:crypto`: this module is reachable from
  // `start()` in every runtime the SDK supports, including edge.
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(input)
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function validateDynamicWorkflowSource(
  source: string,
  exportName: string
): void {
  const byteLength = new TextEncoder().encode(source).byteLength;
  if (byteLength > DYNAMIC_WORKFLOW_SOURCE_MAX_BYTES) {
    throw new WorkflowRuntimeError(
      `Dynamic workflow source is ${byteLength} bytes, over the ${DYNAMIC_WORKFLOW_SOURCE_MAX_BYTES}-byte limit.`
    );
  }

  if (UNSUPPORTED_DYNAMIC_MODULE_SYNTAX.test(source)) {
    throw new WorkflowRuntimeError(
      'Dynamic workflow source cannot use `import` or `export`. Reach registered steps through the injected `steps` object instead.'
    );
  }

  const functionMatch = new RegExp(
    `\\basync\\s+function\\s+${exportName}\\s*\\([^)]*\\)\\s*\\{`
  ).exec(source);
  if (!functionMatch) {
    throw new WorkflowRuntimeError(
      `Dynamic workflow source must declare \`async function ${exportName}(...)\`.`
    );
  }

  const bodyStart = functionMatch.index + functionMatch[0].length;
  const bodyPrefix = source.slice(bodyStart, bodyStart + 200);
  if (!/^\s*(?:"use workflow"|'use workflow')\s*;?/.test(bodyPrefix)) {
    throw new WorkflowRuntimeError(
      `Dynamic workflow function ${JSON.stringify(exportName)} must open with a "use workflow" directive.`
    );
  }
}

function resolveStepId(alias: string, value: unknown): string {
  const stepId =
    (value && typeof value === 'object') || typeof value === 'function'
      ? (value as { stepId?: unknown }).stepId
      : undefined;

  if (typeof stepId !== 'string' || stepId.length === 0) {
    throw new WorkflowRuntimeError(
      `Dynamic workflow step ${JSON.stringify(alias)} must be an imported step function or an object with a non-empty \`stepId\`.`
    );
  }

  return stepId;
}

export interface CompiledDynamicWorkflow {
  /** Generated workflow id, also the run's `workflowName`. */
  workflowName: string;
  /** Workflow VM code to store with the run and replay from. */
  workflowCode: string;
  /** Plaintext metadata for `executionContext.dynamicWorkflow`. */
  metadata: DynamicWorkflowMetadata;
}

/**
 * Validate dynamic source and generate the workflow VM code for it.
 *
 * The workflow id is derived from the source and its step bindings rather
 * than accepted from the caller. Two consequences, both intentional: the same
 * definition always lands on the same queue topic and groups together in
 * observability, and a caller cannot claim a static workflow's id — or
 * another definition's — for arbitrary code.
 */
export async function compileDynamicWorkflow(
  source: string,
  options: DynamicWorkflowOptions
): Promise<CompiledDynamicWorkflow> {
  const exportName = options.exportName ?? 'workflow';
  assertDynamicWorkflowIdentifier('exportName', exportName);
  validateDynamicWorkflowSource(source, exportName);

  if (!options.steps || Object.keys(options.steps).length === 0) {
    throw new WorkflowRuntimeError(
      'Dynamic workflow options must expose at least one registered step through `dynamic.steps`.'
    );
  }

  const stepEntries = Object.entries(options.steps)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([alias, value]) => {
      assertDynamicWorkflowIdentifier('step alias', alias);
      return [alias, resolveStepId(alias, value)] as const;
    });
  const steps = Object.fromEntries(stepEntries);

  const sourceHash = await sha256Hex(
    `${source}\n${stableJsonStringify(steps)}`
  );

  // Half the digest. Long enough that a collision is not a practical concern
  // and short enough to keep queue topic names and observability rows
  // readable.
  const workflowName = `workflow//dynamic/${sourceHash.slice(0, 32)}//${exportName}`;

  const stepBindings = stepEntries
    .map(
      ([alias, stepId]) =>
        `  ${JSON.stringify(alias)}: __dynamicUseStep(${JSON.stringify(stepId)})`
    )
    .join(',\n');

  // The generated wrapper mirrors what the build-time transform emits for a
  // static workflow: pull the VM's primitives off the well-known symbols,
  // then register the function on `globalThis.__private_workflows` under the
  // name the runtime will look it up by.
  const workflowCode = `globalThis.__private_workflows ??= new Map();
const __dynamicUseStep = globalThis[Symbol.for("WORKFLOW_USE_STEP")];
if (typeof __dynamicUseStep !== "function") {
  throw new Error("Dynamic workflows require a workflow VM that provides WORKFLOW_USE_STEP.");
}
const steps = Object.freeze({
${stepBindings}
});
const sleep = globalThis[Symbol.for("WORKFLOW_SLEEP")];
const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
${source}
Object.defineProperty(${exportName}, "workflowId", {
  value: ${JSON.stringify(workflowName)},
  writable: false,
  enumerable: false,
  configurable: false
});
globalThis.__private_workflows.set(${JSON.stringify(workflowName)}, ${exportName});
`;

  return {
    workflowName,
    workflowCode,
    metadata: { version: 1, sourceHash, exportName, steps },
  };
}

/**
 * Read the dynamic-workflow marker off a run's `executionContext`.
 *
 * The runtime uses this to decide whether a run replays from the deployment's
 * bundle or from its own stored code, so it validates the shape rather than
 * trusting it: `executionContext` is client-supplied and passes through the
 * backend unchecked.
 *
 * Returns undefined for every static run, which is the overwhelming majority
 * — this is on the hot path of each delivery.
 */
export function readDynamicWorkflowMetadata(
  executionContext: unknown
): DynamicWorkflowMetadata | undefined {
  if (!executionContext || typeof executionContext !== 'object') {
    return undefined;
  }
  const marker = (executionContext as { dynamicWorkflow?: unknown })
    .dynamicWorkflow;
  if (!marker || typeof marker !== 'object') return undefined;

  const candidate = marker as Partial<DynamicWorkflowMetadata>;
  if (candidate.version !== 1) return undefined;
  if (typeof candidate.exportName !== 'string') return undefined;
  if (typeof candidate.sourceHash !== 'string') return undefined;

  return {
    version: 1,
    sourceHash: candidate.sourceHash,
    exportName: candidate.exportName,
    steps:
      candidate.steps && typeof candidate.steps === 'object'
        ? candidate.steps
        : {},
  };
}
