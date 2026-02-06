import type {
  RawWorkflowManifest,
  WorkflowManifest,
} from './apply-swc-transform.js';

/**
 * A manifest entry with a name and exports keyed by condition.
 */
type ManifestEntry = {
  name: string;
  exports: Record<string, string>;
  [key: string]: unknown;
};

/**
 * Deep merge two manifest entry records, combining the `exports` object
 * from both sources when entries have the same ID.
 *
 * This is used to merge manifests from different bundle contexts (step vs workflow)
 * where the same entry may have different export conditions.
 *
 * @example
 * // Step bundle provides 'default' condition
 * const stepsManifest = { "step//./add": { stepId: "step//./add", name: "add", exports: { default: "add.js" } } }
 * // Workflow bundle provides 'workflow' condition
 * const workflowsManifest = { "step//./add": { stepId: "step//./add", name: "add", exports: { workflow: "add.js" } } }
 * // Merged result has both conditions
 * deepMergeManifestEntries(stepsManifest, workflowsManifest)
 * // => { "step//./add": { stepId: "step//./add", name: "add", exports: { default: "add.js", workflow: "add.js" } } }
 */
export function deepMergeManifestEntries<T extends ManifestEntry>(
  a: Record<string, T> = {} as Record<string, T>,
  b: Record<string, T> = {} as Record<string, T>
): Record<string, T> {
  const result: Record<string, T> = { ...a };
  for (const [id, data] of Object.entries(b)) {
    if (result[id]) {
      // Merge exports from both manifests
      result[id] = {
        ...result[id],
        exports: { ...result[id].exports, ...data.exports },
      };
    } else {
      result[id] = data;
    }
  }
  return result;
}

/**
 * Merge two WorkflowManifest objects, deeply merging the exports for
 * steps, workflows, and classes that appear in both.
 */
export function mergeManifests(
  stepsManifest: Partial<WorkflowManifest>,
  workflowsManifest: Partial<WorkflowManifest>
): WorkflowManifest {
  return {
    steps: deepMergeManifestEntries(
      stepsManifest.steps,
      workflowsManifest.steps
    ),
    workflows: deepMergeManifestEntries(
      stepsManifest.workflows,
      workflowsManifest.workflows
    ),
    classes: deepMergeManifestEntries(
      stepsManifest.classes,
      workflowsManifest.classes
    ),
  };
}

/**
 * Merge a raw manifest (with source) into the final manifest (with exports).
 * The condition is determined by the mode:
 * - step/client mode uses 'default' condition
 * - workflow mode uses 'workflow' condition
 *
 * This function is used by both the base builder and the SWC esbuild plugin
 * to consolidate manifest data from different bundle contexts.
 */
export function mergeRawManifest(
  target: WorkflowManifest,
  raw: RawWorkflowManifest,
  condition: 'default' | 'workflow'
): void {
  // Merge steps
  if (raw.steps) {
    if (!target.steps) target.steps = {};
    for (const [id, data] of Object.entries(raw.steps)) {
      if (!target.steps[id]) {
        target.steps[id] = { stepId: id, name: data.name, exports: {} };
      }
      target.steps[id].exports[condition] = data.source;
    }
  }

  // Merge workflows
  if (raw.workflows) {
    if (!target.workflows) target.workflows = {};
    for (const [id, data] of Object.entries(raw.workflows)) {
      if (!target.workflows[id]) {
        target.workflows[id] = { workflowId: id, name: data.name, exports: {} };
      }
      target.workflows[id].exports[condition] = data.source;
    }
  }

  // Merge classes
  if (raw.classes) {
    if (!target.classes) target.classes = {};
    for (const [id, data] of Object.entries(raw.classes)) {
      if (!target.classes[id]) {
        target.classes[id] = { classId: id, name: data.name, exports: {} };
      }
      target.classes[id].exports[condition] = data.source;
    }
  }
}
