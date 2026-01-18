import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { getWorkbenchAppPath } from './utils';

interface ManifestStep {
  stepId: string;
}

interface ManifestNode {
  id: string;
  type: string;
  data: {
    label: string;
    nodeKind: string;
    stepId?: string;
  };
  metadata?: {
    loopId?: string;
    loopIsAwait?: boolean;
    conditionalId?: string;
    conditionalBranch?: 'Then' | 'Else';
    parallelGroupId?: string;
    parallelMethod?: string;
  };
}

interface ManifestWorkflow {
  workflowId: string;
  graph: {
    nodes: ManifestNode[];
    edges: Array<{
      id: string;
      source: string;
      target: string;
      type?: string;
    }>;
  };
}

interface Manifest {
  version: string;
  steps: Record<string, Record<string, ManifestStep>>;
  workflows: Record<string, Record<string, ManifestWorkflow>>;
}

// Map project names to their manifest paths
const MANIFEST_PATHS: Record<string, string> = {
  'nextjs-webpack': 'app/.well-known/workflow/v1/manifest.json',
  'nextjs-turbopack': 'app/.well-known/workflow/v1/manifest.json',
  nitro: 'node_modules/.nitro/workflow/manifest.json',
  vite: 'node_modules/.nitro/workflow/manifest.json',
  sveltekit: 'src/routes/.well-known/workflow/v1/manifest.json',
  nuxt: 'node_modules/.nitro/workflow/manifest.json',
  hono: 'node_modules/.nitro/workflow/manifest.json',
  express: 'node_modules/.nitro/workflow/manifest.json',
};

function validateSteps(steps: Manifest['steps']) {
  expect(steps).toBeDefined();
  expect(typeof steps).toBe('object');

  const stepFiles = Object.keys(steps);
  expect(stepFiles.length).toBeGreaterThan(0);

  for (const filePath of stepFiles) {
    // Skip internal builtins from packages/workflow/dist/internal/builtins.js
    if (filePath.includes('builtins.js')) {
      continue;
    }

    const fileSteps = steps[filePath];
    for (const [stepName, stepData] of Object.entries(fileSteps)) {
      expect(stepData.stepId).toBeDefined();
      expect(stepData.stepId).toContain('step//');
      expect(stepData.stepId).toContain(stepName);
    }
  }
}

function validateWorkflowGraph(graph: ManifestWorkflow['graph']) {
  expect(graph).toBeDefined();
  expect(graph.nodes).toBeDefined();
  expect(Array.isArray(graph.nodes)).toBe(true);
  expect(graph.edges).toBeDefined();
  expect(Array.isArray(graph.edges)).toBe(true);

  for (const node of graph.nodes) {
    expect(node.id).toBeDefined();
    expect(node.type).toBeDefined();
    expect(node.data).toBeDefined();
    expect(node.data.label).toBeDefined();
    expect(node.data.nodeKind).toBeDefined();
  }

  for (const edge of graph.edges) {
    expect(edge.id).toBeDefined();
    expect(edge.source).toBeDefined();
    expect(edge.target).toBeDefined();
  }

  // Only check for start/end nodes if graph has nodes
  // Some workflows without steps may have empty graphs
  if (graph.nodes.length > 0) {
    const nodeTypes = graph.nodes.map((n) => n.type);
    expect(nodeTypes).toContain('workflowStart');
    expect(nodeTypes).toContain('workflowEnd');
  }
}

function validateWorkflows(workflows: Manifest['workflows']) {
  expect(workflows).toBeDefined();
  expect(typeof workflows).toBe('object');

  const workflowFiles = Object.keys(workflows);
  expect(workflowFiles.length).toBeGreaterThan(0);

  for (const filePath of workflowFiles) {
    const fileWorkflows = workflows[filePath];
    for (const [workflowName, workflowData] of Object.entries(fileWorkflows)) {
      expect(workflowData.workflowId).toBeDefined();
      expect(workflowData.workflowId).toContain('workflow//');
      expect(workflowData.workflowId).toContain(workflowName);
      validateWorkflowGraph(workflowData.graph);
    }
  }
}

/**
 * Helper to safely read manifest, returns null if file doesn't exist
 */
async function tryReadManifest(project: string): Promise<Manifest | null> {
  try {
    const appPath = getWorkbenchAppPath(project);
    const manifestPath = path.join(appPath, MANIFEST_PATHS[project]);
    const manifestContent = await fs.readFile(manifestPath, 'utf8');
    return JSON.parse(manifestContent);
  } catch {
    return null;
  }
}

describe.each(Object.keys(MANIFEST_PATHS))('manifest generation', (project) => {
  test(
    `${project}: manifest.json exists and has valid structure`,
    { timeout: 30_000 },
    async () => {
      // Skip if we're targeting a specific app
      if (process.env.APP_NAME && project !== process.env.APP_NAME) {
        return;
      }

      const manifest = await tryReadManifest(project);
      if (!manifest) return; // Skip if manifest doesn't exist

      expect(manifest.version).toBe('1.0.0');
      validateSteps(manifest.steps);
      validateWorkflows(manifest.workflows);
    }
  );
});

/**
 * Helper to find a workflow by name in the manifest
 */
function findWorkflow(
  manifest: Manifest,
  workflowName: string
): ManifestWorkflow | undefined {
  for (const fileWorkflows of Object.values(manifest.workflows)) {
    if (workflowName in fileWorkflows) {
      return fileWorkflows[workflowName];
    }
  }
  return undefined;
}

/**
 * Helper to get step nodes from a workflow graph
 */
function getStepNodes(graph: ManifestWorkflow['graph']): ManifestNode[] {
  return graph.nodes.filter((n) => n.data.stepId);
}

/**
 * Tests for single-statement control flow extraction.
 * These verify that steps inside if/while/for without braces are extracted.
 * Tests are skipped if manifest doesn't exist or workflow isn't found.
 */
describe.each(Object.keys(MANIFEST_PATHS))(
  'single-statement control flow extraction',
  (project) => {
    test(
      `${project}: single-statement if extracts steps with conditional metadata`,
      { timeout: 30_000 },
      async () => {
        if (process.env.APP_NAME && project !== process.env.APP_NAME) {
          return;
        }

        const manifest = await tryReadManifest(project);
        if (!manifest) return; // Skip if manifest doesn't exist

        const workflow = findWorkflow(manifest, 'single_statement_if');
        if (!workflow) return; // Skip if workflow not in this project

        const stepNodes = getStepNodes(workflow.graph);

        // Should have steps extracted (singleStmtStepA and singleStmtStepB)
        expect(stepNodes.length).toBeGreaterThan(0);

        // Verify steps have stepId containing expected names
        const stepIds = stepNodes.map((n) => n.data.stepId);
        expect(stepIds.some((id) => id?.includes('singleStmtStepA'))).toBe(
          true
        );
        expect(stepIds.some((id) => id?.includes('singleStmtStepB'))).toBe(
          true
        );

        // Verify conditional metadata is present
        const conditionalNodes = stepNodes.filter(
          (n) => n.metadata?.conditionalId
        );
        expect(conditionalNodes.length).toBeGreaterThan(0);

        // Verify we have both Then and Else branches
        const thenNodes = stepNodes.filter(
          (n) => n.metadata?.conditionalBranch === 'Then'
        );
        const elseNodes = stepNodes.filter(
          (n) => n.metadata?.conditionalBranch === 'Else'
        );
        expect(thenNodes.length).toBeGreaterThan(0);
        expect(elseNodes.length).toBeGreaterThan(0);
      }
    );

    test(
      `${project}: single-statement while extracts steps with loop metadata`,
      { timeout: 30_000 },
      async () => {
        if (process.env.APP_NAME && project !== process.env.APP_NAME) {
          return;
        }

        const manifest = await tryReadManifest(project);
        if (!manifest) return; // Skip if manifest doesn't exist

        const workflow = findWorkflow(manifest, 'single_statement_while');
        if (!workflow) return; // Skip if workflow not in this project

        const stepNodes = getStepNodes(workflow.graph);

        // Should have step extracted (singleStmtStepA)
        expect(stepNodes.length).toBeGreaterThan(0);

        const stepIds = stepNodes.map((n) => n.data.stepId);
        expect(stepIds.some((id) => id?.includes('singleStmtStepA'))).toBe(
          true
        );

        // Verify loop metadata is present
        const loopNodes = stepNodes.filter((n) => n.metadata?.loopId);
        expect(loopNodes.length).toBeGreaterThan(0);

        // Verify loop back-edges exist
        const loopEdges = workflow.graph.edges.filter((e) => e.type === 'loop');
        expect(loopEdges.length).toBeGreaterThan(0);
      }
    );

    test(
      `${project}: single-statement for extracts steps with loop metadata`,
      { timeout: 30_000 },
      async () => {
        if (process.env.APP_NAME && project !== process.env.APP_NAME) {
          return;
        }

        const manifest = await tryReadManifest(project);
        if (!manifest) return; // Skip if manifest doesn't exist

        const workflow = findWorkflow(manifest, 'single_statement_for');
        if (!workflow) return; // Skip if workflow not in this project

        const stepNodes = getStepNodes(workflow.graph);

        // Should have steps extracted (singleStmtStepB and singleStmtStepC)
        expect(stepNodes.length).toBeGreaterThan(0);

        const stepIds = stepNodes.map((n) => n.data.stepId);
        expect(stepIds.some((id) => id?.includes('singleStmtStepB'))).toBe(
          true
        );
        expect(stepIds.some((id) => id?.includes('singleStmtStepC'))).toBe(
          true
        );

        // Verify loop metadata is present
        const loopNodes = stepNodes.filter((n) => n.metadata?.loopId);
        expect(loopNodes.length).toBeGreaterThan(0);

        // Verify loop back-edges exist
        const loopEdges = workflow.graph.edges.filter((e) => e.type === 'loop');
        expect(loopEdges.length).toBeGreaterThan(0);
      }
    );
  }
);
