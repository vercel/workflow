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

export type GraphManifest = {
  version: string;
  workflows: {
    [workflowName: string]: {
      workflowId: string;
      workflowName: string;
      filePath: string;
      nodes: Array<{
        id: string;
        type: string;
        position: { x: number; y: number };
        data: {
          label: string;
          nodeKind: string;
          stepId?: string;
          line: number;
        };
      }>;
      edges: Array<{
        id: string;
        source: string;
        target: string;
        type: string;
      }>;
    };
  };
  debugInfo?: {
    manifestPresent: boolean;
    manifestStepFiles: number;
    importsResolved: number;
    importsWithKind: number;
    importDetails: Array<{
      localName: string;
      source: string;
      importedName: string;
      kind: string | null;
      lookupCandidates: string[];
    }>;
  };
};

export async function applySwcTransform(
  filename: string,
  source: string,
  mode: 'workflow' | 'step' | 'client' | 'graph' | false,
  jscConfig?: {
    paths?: Record<string, string[]>;
    // this must be absolute path
    baseUrl?: string;
  },
  workflowManifest?: WorkflowManifest
): Promise<{
  code: string;
  workflowManifest: WorkflowManifest;
  graphManifest?: GraphManifest;
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

  // Extract graph manifest from separate comment
  const graphCommentMatch = result.code.match(
    /\/\*\*__workflow_graph({.*?})\*\//s
  );
  const graphManifest = graphCommentMatch?.[1]
    ? (JSON.parse(graphCommentMatch[1]) as GraphManifest)
    : undefined;

  return {
    code: result.code,
    workflowManifest: parsedWorkflows || {},
    graphManifest,
  };
}
