import {
  detectWorkflowPatterns,
  extractImportSpecifiers,
  isGeneratedWorkflowFile,
  type WorkflowFileInfo,
} from '@workflow/builders';
import type { EnvironmentModuleNode, HotUpdateOptions, Plugin } from 'vite';

const jsTsRegex = /\.[cm]?[jt]sx?(?:$|\?)/;
const workflowImportsMeta = 'workflow:imports';
const workflowModuleMeta = 'workflow:module';

interface WorkflowBuilder {
  build(): Promise<void>;
  getWorkflowFileInfo(file: string): WorkflowFileInfo;
}

function importsWorkflow(modules: EnvironmentModuleNode[]): boolean {
  const pending = [...modules];
  const visited = new Set<EnvironmentModuleNode>();

  while (pending.length > 0) {
    const module = pending.pop()!;
    if (visited.has(module)) continue;
    visited.add(module);

    if (module.info?.meta[workflowModuleMeta] === true) return true;
    pending.push(...module.importers);
  }

  return false;
}

interface WorkflowHotUpdatePluginOptions {
  /**
   * Builder instance or a getter function.
   * Use a getter when the builder is created lazily (e.g., Nitro where it depends on the nitro object).
   */
  builder: WorkflowBuilder | (() => WorkflowBuilder | undefined) | undefined;
  /**
   * Optional build queue function to prevent concurrent builds.
   * If not provided, builds will run directly.
   */
  enqueue?: (fn: () => Promise<void>) => Promise<void>;
}

/**
 * Vite plugin that watches for workflow/step file changes and triggers rebuilds.
 *
 * Directives and serialization files are marked during Vite transforms. Hot
 * updates follow Vite's importer graph back to those files before rebuilding.
 */
export function workflowHotUpdatePlugin(
  options: WorkflowHotUpdatePluginOptions
): Plugin {
  const { builder, enqueue } = options;

  // Default enqueue runs the function directly
  const runBuild = enqueue ?? ((fn: () => Promise<void>) => fn());
  let handledTimestamp: number | undefined;

  return {
    name: 'workflow:hot-update',
    enforce: 'pre',
    transform(code, id) {
      if (!jsTsRegex.test(id) || isGeneratedWorkflowFile(id)) return;

      const patterns = detectWorkflowPatterns(code);
      return {
        meta: {
          [workflowImportsMeta]: extractImportSpecifiers(code).join('\n'),
          [workflowModuleMeta]: patterns.hasDirective || patterns.hasSerde,
        },
      };
    },
    async hotUpdate(ctx: HotUpdateOptions) {
      const { file, modules, read, timestamp, type: updateType } = ctx;
      if (isGeneratedWorkflowFile(file)) {
        return;
      }

      const resolvedBuilder =
        typeof builder === 'function' ? builder() : builder;
      if (!resolvedBuilder) return;

      const fileInfo = resolvedBuilder.getWorkflowFileInfo(file);
      let rebuild = importsWorkflow(modules);
      switch (fileInfo.kind) {
        case 'untracked':
          break;
        case 'asset':
          rebuild = true;
          break;
        case 'source':
          rebuild ||= fileInfo.affectsBuild;
          break;
        default:
          fileInfo satisfies never;
          throw new Error('Unknown workflow file info');
      }

      switch (updateType) {
        case 'create':
        case 'update': {
          if (jsTsRegex.test(file)) {
            try {
              const source = await read();
              const patterns = detectWorkflowPatterns(source);
              const imports = extractImportSpecifiers(source).join('\n');
              rebuild ||=
                patterns.hasDirective ||
                patterns.hasSerde ||
                (updateType === 'create' && imports !== '') ||
                (fileInfo.kind === 'source' &&
                  fileInfo.importSignature !== imports) ||
                modules.some(
                  (module) => module.info?.meta[workflowImportsMeta] !== imports
                );
            } catch {
              rebuild = true;
            }
          }
          break;
        }
        case 'delete':
          break;
        default:
          updateType satisfies never;
          throw new Error('Unknown Vite hot update type');
      }

      if (!rebuild) return;
      if (handledTimestamp === timestamp) return;
      handledTimestamp = timestamp;

      console.log('Workflow file changed, rebuilding...');
      await runBuild(() => resolvedBuilder.build());
    },
  };
}
