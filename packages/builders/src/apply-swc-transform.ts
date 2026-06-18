import { createRequire } from 'node:module';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transform } from '@swc/core';
import { parseWorkflowName } from '@workflow/utils/parse-name';
import { getDecoratorOptionsForDirectory } from './config-helpers.js';
import { resolveModuleSpecifier } from './module-specifier.js';

const require = createRequire(import.meta.url);

// Cache decorator options per directory - tsconfig doesn't change during a build
const decoratorOptionsCache = new Map<
  string,
  ReturnType<typeof getDecoratorOptionsForDirectory>
>();

function getDecoratorOptions(projectRoot?: string) {
  const cwd = projectRoot ?? process.cwd();
  let cached = decoratorOptionsCache.get(cwd);
  if (!cached) {
    cached = getDecoratorOptionsForDirectory(cwd);
    decoratorOptionsCache.set(cwd, cached);
  }
  return cached;
}

export type WorkflowManifest = {
  steps?: {
    [relativeFileName: string]: {
      [functionName: string]: {
        stepId: string;
      };
    };
  };
  workflows?: {
    [relativeFileName: string]: {
      [functionName: string]: {
        workflowId: string;
      };
    };
  };
  classes?: {
    [relativeFileName: string]: {
      [className: string]: {
        classId: string;
      };
    };
  };
};

/**
 * Derives the deduplicated, sorted set of workflow source filenames from a
 * manifest, suitable for `workflowEntrypoint`'s `workflowFilenames` option.
 *
 * The runtime compiles each workflow bundle `vm.Script` under the filename
 * `parseWorkflowName(workflowId)?.moduleSpecifier || workflowId`, so the
 * filenames are derived from the `workflowId`s (not the manifest's relative
 * filename keys, which may differ from the embedded module specifier) and
 * deduplicated — the filename is per source file, not per workflow function.
 */
export function getWorkflowFilenamesFromManifest(
  manifest: WorkflowManifest
): string[] {
  const filenames = new Set<string>();
  for (const fnEntries of Object.values(manifest.workflows ?? {})) {
    for (const { workflowId } of Object.values(fnEntries)) {
      filenames.add(
        parseWorkflowName(workflowId)?.moduleSpecifier || workflowId
      );
    }
  }
  return [...filenames].sort();
}

export async function applySwcTransform(
  filename: string,
  source: string,
  mode: 'workflow' | 'step' | 'detect' | false,
  /**
   * Optional absolute path to the file being transformed.
   * Used for module specifier resolution when filename is relative.
   * If not provided, filename is joined with process.cwd().
   */
  absolutePath?: string,
  /**
   * Optional project root used for transform context such as tsconfig lookup.
   * Defaults to process.cwd() for backwards compatibility.
   */
  projectRoot?: string,
  /**
   * Optional project root used for package/workspace module-specifier
   * resolution. Defaults to projectRoot for backwards compatibility.
   */
  moduleSpecifierRoot?: string
): Promise<{
  code: string;
  workflowManifest: WorkflowManifest;
}> {
  const resolvedProjectRoot = projectRoot ?? process.cwd();
  const resolvedModuleSpecifierRoot =
    moduleSpecifierRoot ?? resolvedProjectRoot;
  const decoratorOptions = await getDecoratorOptions(resolvedProjectRoot);

  const swcPluginPath = require.resolve('@workflow/swc-plugin', {
    paths: [dirname(fileURLToPath(import.meta.url))],
  });

  // Determine if this is a TypeScript file
  const isTypeScript =
    filename.endsWith('.ts') ||
    filename.endsWith('.tsx') ||
    filename.endsWith('.mts') ||
    filename.endsWith('.cts');

  // Resolve module specifier for packages (node_modules or workspace packages)
  const absoluteFilename = absolutePath
    ? absolutePath
    : isAbsolute(filename)
      ? filename
      : join(resolvedProjectRoot, filename);
  const { moduleSpecifier } = resolveModuleSpecifier(
    absoluteFilename,
    resolvedModuleSpecifierRoot
  );

  // Transform with SWC to support syntax esbuild doesn't
  const result = await transform(source, {
    filename,
    swcrc: false,
    jsc: {
      parser: {
        ...(isTypeScript
          ? {
              syntax: 'typescript',
              tsx: filename.endsWith('.tsx'),
              decorators: decoratorOptions.decorators,
            }
          : {
              syntax: 'ecmascript',
              jsx: filename.endsWith('.jsx'),
              decorators: decoratorOptions.decorators,
            }),
      },
      target: 'es2022',
      experimental: mode
        ? {
            plugins: [[swcPluginPath, { mode, moduleSpecifier }]],
          }
        : undefined,
      transform: {
        react: {
          runtime: 'preserve',
        },
        legacyDecorator: decoratorOptions.legacyDecorator,
        decoratorMetadata: decoratorOptions.decoratorMetadata,
      },
    },
    // TODO: investigate proper source map support as they
    // won't even be used in Node.js by default unless we
    // intercept errors and apply them ourselves
    sourceMaps: false,
    minify: false,
  });

  const workflowCommentMatch = result.code.match(
    /\/\*\*__internal_workflows({.*?})\*\//s
  );

  const parsedWorkflows = JSON.parse(
    workflowCommentMatch?.[1] || '{}'
  ) as WorkflowManifest;

  return {
    code: result.code,
    workflowManifest: parsedWorkflows || {},
  };
}
