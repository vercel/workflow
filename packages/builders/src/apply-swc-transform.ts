import { createRequire } from 'node:module';
import { transform } from '@swc/core';

const require = createRequire(import.meta.url);

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
};

// Graph manifest types moved to graph-extractor.ts (post-bundle extraction)

export async function applySwcTransform(
  filename: string,
  source: string,
  mode: 'workflow' | 'step' | 'client' | false,
  jscConfig?: {
    paths?: Record<string, string[]>;
    // this must be absolute path
    baseUrl?: string;
  },
  workflowManifest?: WorkflowManifest
): Promise<{
  code: string;
  workflowManifest: WorkflowManifest;
}> {
  // Determine if this is a TypeScript file
  const isTypeScript = filename.endsWith('.ts') || filename.endsWith('.tsx');
  const isTsx = filename.endsWith('.tsx');

  // Transform with SWC to support syntax esbuild doesn't
  const result = await transform(source, {
    filename,
    swcrc: false,
    jsc: {
      parser: {
        syntax: isTypeScript ? 'typescript' : 'ecmascript',
        tsx: isTsx,
      },
      target: 'es2022',
      experimental: mode
        ? {
            plugins: [
              [
                require.resolve('@workflow/swc-plugin'),
                { mode, workflowManifest },
              ],
            ],
          }
        : undefined,
      ...jscConfig,
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

  const metadata = JSON.parse(workflowCommentMatch?.[1] || '{}');

  const parsedWorkflows = {
    steps: metadata.steps,
    workflows: metadata.workflows,
  } as WorkflowManifest;

  return {
    code: result.code,
    workflowManifest: parsedWorkflows || {},
  };
}
