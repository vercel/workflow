import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transform } from '@swc/core';
import { getDecoratorOptionsForDirectory } from './config-helpers.js';

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

export interface SwcTransformOptions {
  /**
   * When the file comes from a package in node_modules, this is the package path
   * relative to the project root (e.g., "node_modules/just-bash").
   *
   * Used to generate stable IDs (workflow, step, class) that work across different
   * export conditions. Different export conditions resolve to different files, but
   * should produce the same IDs for serialization compatibility.
   */
  packagePath?: string;
}

export async function applySwcTransform(
  filename: string,
  source: string,
  mode: 'workflow' | 'step' | 'client' | false,
  options?: SwcTransformOptions
): Promise<{
  code: string;
  workflowManifest: WorkflowManifest;
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

  // Build plugin config - include packagePath if provided
  // Note: pluginConfig is only used when mode is truthy (string), so the cast is safe
  const pluginConfig: { mode: string; packagePath?: string } = {
    mode: mode as string,
  };
  if (options?.packagePath) {
    pluginConfig.packagePath = options.packagePath;
  }

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
            plugins: [[swcPluginPath, pluginConfig]],
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
