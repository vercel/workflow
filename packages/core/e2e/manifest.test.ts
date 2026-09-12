import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { getWorkbenchAppPath } from './workbench-path';

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

interface ManifestLocation {
  path?: string;
  skipReason?: string;
}

// Map every local-production matrix app to its build-time manifest behavior.
// Nest creates its manifest when the application starts, after this CI phase;
// the live E2E suite validates its public manifest instead.
const MANIFEST_LOCATIONS: Record<string, ManifestLocation> = {
  'nextjs-webpack': { path: 'app/.well-known/workflow/v1/manifest.json' },
  'nextjs-turbopack': { path: 'app/.well-known/workflow/v1/manifest.json' },
  nitro: { path: 'node_modules/.nitro/workflow/manifest.json' },
  vite: { path: 'node_modules/.nitro/workflow/manifest.json' },
  sveltekit: { path: 'src/routes/.well-known/workflow/v1/manifest.json' },
  nuxt: { path: '.nuxt/workflow/manifest.json' },
  hono: { path: 'node_modules/.nitro/workflow/manifest.json' },
  express: { path: 'node_modules/.nitro/workflow/manifest.json' },
  fastify: { path: 'node_modules/.nitro/workflow/manifest.json' },
  nest: {
    skipReason: 'Nest generates its manifest when the application starts',
  },
  astro: { path: 'src/pages/.well-known/workflow/v1/manifest.json' },
  'tanstack-start': { path: 'node_modules/.nitro/workflow/manifest.json' },
};

if (process.env.APP_NAME && !(process.env.APP_NAME in MANIFEST_LOCATIONS)) {
  throw new Error(
    `No manifest path is declared for targeted app "${process.env.APP_NAME}"`
  );
}
if (process.env.WORKBENCH_APP_PATH && !process.env.APP_NAME) {
  throw new Error('`WORKBENCH_APP_PATH` requires `APP_NAME`');
}

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
 * Reads a manifest, returning null only when it has not been generated. Parse
 * and other I/O errors must fail the test rather than silently disabling it.
 */
async function tryReadManifest(project: string): Promise<Manifest | null> {
  const appPath = getWorkbenchAppPath(project);
  const manifestPath = path.join(
    appPath,
    requireDefined(
      MANIFEST_LOCATIONS[project].path,
      `No build-time manifest path for ${project}`
    )
  );

  try {
    const manifestContent = await fs.readFile(manifestPath, 'utf8');
    return JSON.parse(manifestContent);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function requireTargetManifest(project: string, manifest: Manifest | null) {
  if (manifest) return manifest;

  throw new Error(
    `Manifest for targeted app "${project}" was not generated at ${MANIFEST_LOCATIONS[project].path}`
  );
}

function requireDefined<T>(value: T | undefined, message: string): T {
  expect(value, message).toBeDefined();
  if (value === undefined) throw new Error(message);
  return value;
}

function skipWithoutBuildManifest(
  project: string,
  skip: (note?: string) => never
) {
  const reason = MANIFEST_LOCATIONS[project].skipReason;
  if (reason) skip(reason);
}

describe.each(
  Object.keys(MANIFEST_LOCATIONS)
)('manifest generation', (project) => {
  test(
    `${project}: manifest.json exists and has valid structure`,
    { timeout: 30_000 },
    async ({ skip }) => {
      // A CI invocation targets the app built by the preceding step. Local
      // all-project invocations explicitly skip apps that have not been built.
      if (process.env.APP_NAME && project !== process.env.APP_NAME) {
        skip(`Targeting ${process.env.APP_NAME}`);
      }
      skipWithoutBuildManifest(project, skip);

      const candidate = await tryReadManifest(project);
      if (!candidate && !process.env.APP_NAME) {
        skip('Manifest has not been generated');
      }
      const manifest = requireTargetManifest(project, candidate);

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
 * Tests that steps and workflows inside dot-prefixed directories like
 * `.well-known/agent/` are correctly discovered and included in the manifest.
 * This verifies the fix for tinyglobby's `dot: true` option.
 */
describe.each([
  'nextjs-webpack',
  'nextjs-turbopack',
])('dot-directory discovery (.well-known/agent)', (project) => {
  test(
    `${project}: discovers steps inside .well-known/agent directory`,
    { timeout: 30_000 },
    async ({ skip }) => {
      if (process.env.APP_NAME && project !== process.env.APP_NAME) {
        skip(`Targeting ${process.env.APP_NAME}`);
      }

      const candidate = await tryReadManifest(project);
      if (!candidate && !process.env.APP_NAME) {
        skip('Manifest has not been generated');
      }
      const manifest = requireTargetManifest(project, candidate);

      // Find the step from .well-known/agent/v1/steps.ts
      const stepFiles = Object.keys(manifest.steps);
      const wellKnownStepFile = stepFiles.find(
        (f) => f.includes('.well-known/agent') || f.includes('well-known/agent')
      );
      expect(
        wellKnownStepFile,
        `Expected a step file matching ".well-known/agent" in manifest steps. Available: ${stepFiles.join(', ')}`
      ).toBeDefined();

      const fileSteps =
        manifest.steps[
          requireDefined(wellKnownStepFile, 'Well-known step file is missing')
        ];
      expect(fileSteps.wellKnownAgentStep).toBeDefined();
      expect(fileSteps.wellKnownAgentStep.stepId).toContain(
        'wellKnownAgentStep'
      );
    }
  );

  test(
    `${project}: discovers workflows inside .well-known/agent directory`,
    { timeout: 30_000 },
    async ({ skip }) => {
      if (process.env.APP_NAME && project !== process.env.APP_NAME) {
        skip(`Targeting ${process.env.APP_NAME}`);
      }

      const candidate = await tryReadManifest(project);
      if (!candidate && !process.env.APP_NAME) {
        skip('Manifest has not been generated');
      }
      const manifest = requireTargetManifest(project, candidate);

      // Find the workflow from .well-known/agent/v1/steps.ts
      const workflowFiles = Object.keys(manifest.workflows);
      const wellKnownWorkflowFile = workflowFiles.find(
        (f) => f.includes('.well-known/agent') || f.includes('well-known/agent')
      );
      expect(
        wellKnownWorkflowFile,
        `Expected a workflow file matching ".well-known/agent" in manifest workflows. Available: ${workflowFiles.join(', ')}`
      ).toBeDefined();

      const fileWorkflows =
        manifest.workflows[
          requireDefined(
            wellKnownWorkflowFile,
            'Well-known workflow file is missing'
          )
        ];
      expect(fileWorkflows.wellKnownAgentWorkflow).toBeDefined();
      expect(fileWorkflows.wellKnownAgentWorkflow.workflowId).toContain(
        'wellKnownAgentWorkflow'
      );
    }
  );
});

/**
 * Tests for single-statement control flow extraction.
 * These verify that steps inside if/while/for without braces are extracted.
 */
describe.each(
  Object.keys(MANIFEST_LOCATIONS)
)('single-statement control flow extraction', (project) => {
  test(
    `${project}: single-statement if extracts steps with conditional metadata`,
    { timeout: 30_000 },
    async ({ skip }) => {
      if (process.env.APP_NAME && project !== process.env.APP_NAME) {
        skip(`Targeting ${process.env.APP_NAME}`);
      }
      skipWithoutBuildManifest(project, skip);
      const candidate = await tryReadManifest(project);
      if (!candidate && !process.env.APP_NAME) {
        skip('Manifest has not been generated');
      }
      const manifest = requireTargetManifest(project, candidate);
      const workflow = requireDefined(
        findWorkflow(manifest, 'single_statement_if'),
        'single_statement_if is missing from manifest'
      );

      const stepNodes = getStepNodes(workflow.graph);

      // Should have steps extracted (singleStmtStepA and singleStmtStepB)
      expect(stepNodes.length).toBeGreaterThan(0);

      // Verify steps have stepId containing expected names
      const stepIds = stepNodes.map((n) => n.data.stepId);
      expect(stepIds.some((id) => id?.includes('singleStmtStepA'))).toBe(true);
      expect(stepIds.some((id) => id?.includes('singleStmtStepB'))).toBe(true);

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
    async ({ skip }) => {
      if (process.env.APP_NAME && project !== process.env.APP_NAME) {
        skip(`Targeting ${process.env.APP_NAME}`);
      }
      skipWithoutBuildManifest(project, skip);
      const candidate = await tryReadManifest(project);
      if (!candidate && !process.env.APP_NAME) {
        skip('Manifest has not been generated');
      }
      const manifest = requireTargetManifest(project, candidate);
      const workflow = requireDefined(
        findWorkflow(manifest, 'single_statement_while'),
        'single_statement_while is missing from manifest'
      );

      const stepNodes = getStepNodes(workflow.graph);

      // Should have step extracted (singleStmtStepA)
      expect(stepNodes.length).toBeGreaterThan(0);

      const stepIds = stepNodes.map((n) => n.data.stepId);
      expect(stepIds.some((id) => id?.includes('singleStmtStepA'))).toBe(true);

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
    async ({ skip }) => {
      if (process.env.APP_NAME && project !== process.env.APP_NAME) {
        skip(`Targeting ${process.env.APP_NAME}`);
      }
      skipWithoutBuildManifest(project, skip);
      const candidate = await tryReadManifest(project);
      if (!candidate && !process.env.APP_NAME) {
        skip('Manifest has not been generated');
      }
      const manifest = requireTargetManifest(project, candidate);
      const workflow = requireDefined(
        findWorkflow(manifest, 'single_statement_for'),
        'single_statement_for is missing from manifest'
      );

      const stepNodes = getStepNodes(workflow.graph);

      // Should have steps extracted (singleStmtStepB and singleStmtStepC)
      expect(stepNodes.length).toBeGreaterThan(0);

      const stepIds = stepNodes.map((n) => n.data.stepId);
      expect(stepIds.some((id) => id?.includes('singleStmtStepB'))).toBe(true);
      expect(stepIds.some((id) => id?.includes('singleStmtStepC'))).toBe(true);

      // Verify loop metadata is present
      const loopNodes = stepNodes.filter((n) => n.metadata?.loopId);
      expect(loopNodes.length).toBeGreaterThan(0);

      // Verify loop back-edges exist
      const loopEdges = workflow.graph.edges.filter((e) => e.type === 'loop');
      expect(loopEdges.length).toBeGreaterThan(0);
    }
  );
});
