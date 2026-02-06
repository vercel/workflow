import { createRequire } from 'node:module';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transform } from '@swc/core';
import { getDecoratorOptionsForDirectory } from './config-helpers.js';
import { resolveModuleSpecifier } from './module-specifier.js';

const require = createRequire(import.meta.url);

// Cache decorator options per directory - tsconfig doesn't change during a build
const decoratorOptionsCache = new Map<
  string,
  ReturnType<typeof getDecoratorOptionsForDirectory>
>();

function getDecoratorOptions() {
  const cwd = process.cwd();
  let cached = decoratorOptionsCache.get(cwd);
  if (!cached) {
    cached = getDecoratorOptionsForDirectory(cwd);
    decoratorOptionsCache.set(cwd, cached);
  }
  return cached;
}

/**
 * Raw manifest format emitted by SWC plugin for a single file.
 * Has `source` as a single string (the file being transformed).
 */
export type RawWorkflowManifest = {
  steps?: {
    [stepId: string]: {
      name: string;
      source: string;
    };
  };
  workflows?: {
    [workflowId: string]: {
      name: string;
      source: string;
    };
  };
  classes?: {
    [classId: string]: {
      name: string;
      source: string;
    };
  };
};

/**
 * Final manifest format with exports keyed by condition.
 * This is what gets written to manifest.json.
 *
 * Each entry includes its own ID for easy use with APIs like `start()`.
 */
export type WorkflowManifest = {
  steps?: {
    [stepId: string]: {
      stepId: string;
      name: string;
      exports: {
        [condition: string]: string;
      };
    };
  };
  workflows?: {
    [workflowId: string]: {
      workflowId: string;
      name: string;
      exports: {
        [condition: string]: string;
      };
      graph?: {
        nodes: unknown[];
        edges: unknown[];
      };
    };
  };
  classes?: {
    [classId: string]: {
      classId: string;
      name: string;
      exports: {
        [condition: string]: string;
      };
    };
  };
};

export async function applySwcTransform(
  filename: string,
  source: string,
  mode: 'workflow' | 'step' | 'client' | false,
  /**
   * Optional absolute path to the file being transformed.
   * Used for module specifier resolution when filename is relative.
   * If not provided, filename is joined with process.cwd().
   */
  absolutePath?: string
): Promise<{
  code: string;
  workflowManifest: RawWorkflowManifest;
}> {
  const decoratorOptions = await getDecoratorOptions();

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
  const projectRoot = process.cwd();
  const absoluteFilename = absolutePath
    ? absolutePath
    : isAbsolute(filename)
      ? filename
      : join(projectRoot, filename);
  const { moduleSpecifier } = resolveModuleSpecifier(
    absoluteFilename,
    projectRoot
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
  ) as RawWorkflowManifest;

  return {
    code: result.code,
    workflowManifest: parsedWorkflows || {},
  };
}
