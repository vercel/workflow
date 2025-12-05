/**
 * Utilities to map workflow run data to graph execution overlays
 */

import type { Event, Step, WorkflowRun } from '@workflow/web-shared';
import type {
  EdgeTraversal,
  GraphNode,
  StepExecution,
  WorkflowGraph,
  WorkflowRunExecution,
} from './workflow-graph-types';

/**
 * Normalize step/workflow names by removing path traversal patterns
 * Graph has: "step//../example/workflows/1_simple.ts//add"
 * Runtime has: "step//example/workflows/1_simple.ts//add"
 */
function normalizeStepName(name: string): string {
  // Remove //../ patterns (path traversal)
  return name.replace(/\/\/\.\.\//g, '//');
}

/**
 * Create execution data for a single step attempt
 * Handles all step statuses: pending, running, completed, failed, cancelled
 */
function createStepExecution(
  attemptStep: Step,
  graphNodeId: string,
  idx: number,
  totalAttempts: number
): StepExecution {
  // Map step status to execution status
  let status: StepExecution['status'];
  switch (attemptStep.status) {
    case 'completed':
      status = 'completed';
      break;
    case 'failed':
      // If this is not the last attempt, it's a retry
      status = idx < totalAttempts - 1 ? 'retrying' : 'failed';
      break;
    case 'running':
      status = 'running';
      break;
    case 'cancelled':
      status = 'cancelled';
      break;
    case 'pending':
    default:
      status = 'pending';
      break;
  }

  const duration =
    attemptStep.completedAt && attemptStep.startedAt
      ? new Date(attemptStep.completedAt).getTime() -
        new Date(attemptStep.startedAt).getTime()
      : undefined;

  return {
    nodeId: graphNodeId,
    stepId: attemptStep.stepId,
    attemptNumber: attemptStep.attempt,
    status,
    startedAt: attemptStep.startedAt
      ? new Date(attemptStep.startedAt).toISOString()
      : undefined,
    completedAt: attemptStep.completedAt
      ? new Date(attemptStep.completedAt).toISOString()
      : undefined,
    duration,
    input: attemptStep.input,
    output: attemptStep.output,
    error: attemptStep.error
      ? {
          message: attemptStep.error.message,
          stack: attemptStep.error.stack || '',
        }
      : undefined,
  };
}

/**
 * Extract function name from a step ID
 * "step//workflows/steps/post-slack-message.ts//postSlackMessage" -> "postSlackMessage"
 */
function extractFunctionName(stepId: string): string | null {
  const parts = stepId.split('//');
  return parts.length >= 3 ? parts[parts.length - 1] : null;
}

/**
 * Build index of graph nodes by normalized stepId and by function name
 */
function buildNodeIndex(nodes: GraphNode[]): {
  byStepId: Map<string, GraphNode[]>;
  byFunctionName: Map<string, GraphNode[]>;
} {
  const byStepId = new Map<string, GraphNode[]>();
  const byFunctionName = new Map<string, GraphNode[]>();

  for (const node of nodes) {
    if (node.data.stepId) {
      // Index by full step ID
      const normalizedStepId = normalizeStepName(node.data.stepId);
      const existing = byStepId.get(normalizedStepId) || [];
      existing.push(node);
      byStepId.set(normalizedStepId, existing);

      // Also index by function name for fallback matching
      const functionName = extractFunctionName(normalizedStepId);
      if (functionName) {
        const existingByName = byFunctionName.get(functionName) || [];
        existingByName.push(node);
        byFunctionName.set(functionName, existingByName);
      }
    }
  }
  return { byStepId, byFunctionName };
}

/**
 * Calculate edge traversals based on execution path
 */
function calculateEdgeTraversals(
  executionPath: string[],
  graph: WorkflowGraph
): Map<string, EdgeTraversal> {
  const edgeTraversals = new Map<string, EdgeTraversal>();

  for (let i = 0; i < executionPath.length - 1; i++) {
    const sourceNodeId = executionPath[i];
    const targetNodeId = executionPath[i + 1];

    const edge = graph.edges.find(
      (e) => e.source === sourceNodeId && e.target === targetNodeId
    );

    if (edge) {
      const existing = edgeTraversals.get(edge.id);
      if (existing) {
        existing.traversalCount++;
      } else {
        edgeTraversals.set(edge.id, {
          edgeId: edge.id,
          traversalCount: 1,
          timings: [],
        });
      }
    }
  }

  return edgeTraversals;
}

/**
 * Initialize start node execution
 */
function initializeStartNode(
  run: WorkflowRun,
  graph: WorkflowGraph,
  executionPath: string[],
  nodeExecutions: Map<string, StepExecution[]>
): void {
  const startNode = graph.nodes.find(
    (n) => n.data.nodeKind === 'workflow_start'
  );
  if (startNode) {
    executionPath.push(startNode.id);
    nodeExecutions.set(startNode.id, [
      {
        nodeId: startNode.id,
        attemptNumber: 1,
        status: 'completed',
        startedAt: run.startedAt
          ? new Date(run.startedAt).toISOString()
          : undefined,
        completedAt: run.startedAt
          ? new Date(run.startedAt).toISOString()
          : undefined,
        duration: 0,
      },
    ]);
  }
}

/**
 * Add end node execution based on workflow run status
 * Handles all run statuses: pending, running, completed, failed, paused, cancelled
 */
function addEndNodeExecution(
  run: WorkflowRun,
  graph: WorkflowGraph,
  executionPath: string[],
  nodeExecutions: Map<string, StepExecution[]>
): void {
  const endNode = graph.nodes.find((n) => n.data.nodeKind === 'workflow_end');
  if (!endNode || executionPath.includes(endNode.id)) {
    return;
  }

  // Map run status to end node execution status
  let endNodeStatus: StepExecution['status'];
  switch (run.status) {
    case 'completed':
      endNodeStatus = 'completed';
      break;
    case 'failed':
      endNodeStatus = 'failed';
      break;
    case 'cancelled':
      endNodeStatus = 'cancelled';
      break;
    case 'running':
      endNodeStatus = 'running';
      break;
    case 'paused':
      // Paused is like running but waiting
      endNodeStatus = 'pending';
      break;
    case 'pending':
    default:
      // Don't add end node for pending runs
      return;
  }

  executionPath.push(endNode.id);
  nodeExecutions.set(endNode.id, [
    {
      nodeId: endNode.id,
      attemptNumber: 1,
      status: endNodeStatus,
      startedAt: run.completedAt
        ? new Date(run.completedAt).toISOString()
        : undefined,
      completedAt: run.completedAt
        ? new Date(run.completedAt).toISOString()
        : undefined,
      duration: 0,
    },
  ]);
}

/**
 * Process a group of step attempts and map to graph node
 */
function processStepGroup(
  stepGroup: Step[],
  stepName: string,
  nodesByStepId: Map<string, GraphNode[]>,
  nodesByFunctionName: Map<string, GraphNode[]>,
  occurrenceCount: Map<string, number>,
  nodeExecutions: Map<string, StepExecution[]>,
  executionPath: string[]
): string | undefined {
  const normalizedStepName = normalizeStepName(stepName);
  const occurrenceIndex = occurrenceCount.get(normalizedStepName) || 0;
  occurrenceCount.set(normalizedStepName, occurrenceIndex + 1);

  let nodesWithStepId = nodesByStepId.get(normalizedStepName) || [];
  let matchStrategy = 'step-id';

  // Fallback: If no exact stepId match, try matching by function name
  // This handles cases where step functions are in separate files
  if (nodesWithStepId.length === 0) {
    const functionName = extractFunctionName(normalizedStepName);
    if (functionName) {
      nodesWithStepId = nodesByFunctionName.get(functionName) || [];
      matchStrategy = 'function-name';
    }
  }

  // If there's only one node for this step but multiple invocations,
  // map all invocations to that single node
  const graphNode =
    nodesWithStepId.length === 1
      ? nodesWithStepId[0]
      : nodesWithStepId[occurrenceIndex];

  console.log('[Graph Mapper] Processing step group:', {
    stepName,
    normalizedStepName,
    attempts: stepGroup.length,
    occurrenceIndex,
    totalNodesWithStepId: nodesWithStepId.length,
    selectedNode: graphNode?.id,
    allNodesWithStepId: nodesWithStepId.map((n) => n.id),
    matchStrategy,
    strategy:
      nodesWithStepId.length === 1
        ? 'single-node-multiple-invocations'
        : 'occurrence-based',
  });

  if (!graphNode) {
    return undefined;
  }

  const executions: StepExecution[] = stepGroup.map((attemptStep, idx) =>
    createStepExecution(attemptStep, graphNode.id, idx, stepGroup.length)
  );

  // If there's only one node, append executions instead of replacing
  if (nodesWithStepId.length === 1) {
    const existing = nodeExecutions.get(graphNode.id) || [];
    nodeExecutions.set(graphNode.id, [...existing, ...executions]);
  } else {
    nodeExecutions.set(graphNode.id, executions);
  }

  if (!executionPath.includes(graphNode.id)) {
    executionPath.push(graphNode.id);
  }

  const latestExecution = executions[executions.length - 1];
  return latestExecution.status === 'running' ? graphNode.id : undefined;
}

/**
 * Maps a workflow run and its steps/events to an execution overlay for the graph
 */
export function mapRunToExecution(
  run: WorkflowRun,
  steps: Step[],
  _events: Event[],
  graph: WorkflowGraph
): WorkflowRunExecution {
  const nodeExecutions = new Map<string, StepExecution[]>();
  const executionPath: string[] = [];
  let currentNode: string | undefined;

  console.log('[Graph Mapper] Mapping run to execution:', {
    runId: run.runId,
    workflowName: run.workflowName,
    graphNodes: graph.nodes.length,
    stepsCount: steps.length,
  });

  // Start node is always executed first
  initializeStartNode(run, graph, executionPath, nodeExecutions);

  // Map steps to graph nodes
  // Sort steps by createdAt to process in execution order
  const sortedSteps = [...steps].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );

  console.log(
    '[Graph Mapper] Sorted steps:',
    sortedSteps.map((s) => ({
      stepId: s.stepId,
      stepName: s.stepName,
      attempt: s.attempt,
      status: s.status,
      createdAt: s.createdAt,
    }))
  );

  // Build an index of graph nodes by normalized stepId and function name for quick lookup
  const { byStepId: nodesByStepId, byFunctionName: nodesByFunctionName } =
    buildNodeIndex(graph.nodes);

  console.log('[Graph Mapper] Graph nodes by stepId:', {
    allGraphNodes: graph.nodes.map((n) => ({
      id: n.id,
      stepId: n.data.stepId,
      normalizedStepId: n.data.stepId
        ? normalizeStepName(n.data.stepId)
        : undefined,
      nodeKind: n.data.nodeKind,
    })),
    nodesByStepId: Array.from(nodesByStepId.entries()).map(
      ([stepId, nodes]) => ({
        stepId,
        nodeIds: nodes.map((n) => n.id),
      })
    ),
  });

  // Track how many times we've seen each stepName to map to the correct occurrence
  const stepNameOccurrenceCount = new Map<string, number>();

  // Group consecutive retries: steps with the same stepId (unique per invocation) are retries
  let currentStepGroup: Step[] = [];
  let currentStepId: string | null = null;
  let currentStepName: string | null = null;

  for (let i = 0; i <= sortedSteps.length; i++) {
    const step = sortedSteps[i];

    // Start a new group if:
    // 1. Different stepId (each invocation has a unique stepId, retries share the same stepId)
    // 2. End of array
    const isNewInvocation = !step || step.stepId !== currentStepId;

    if (isNewInvocation) {
      // Process the previous group if it exists
      if (currentStepGroup.length > 0 && currentStepName) {
        const runningNode = processStepGroup(
          currentStepGroup,
          currentStepName,
          nodesByStepId,
          nodesByFunctionName,
          stepNameOccurrenceCount,
          nodeExecutions,
          executionPath
        );
        if (runningNode) {
          currentNode = runningNode;
        }
      }

      // Start a new group with current step (if not at end)
      if (step) {
        currentStepGroup = [step];
        currentStepId = step.stepId;
        currentStepName = step.stepName;
      }
    } else {
      // Add to current group (this is a retry: same stepId)
      currentStepGroup.push(step);
    }
  }

  // Add end node based on workflow status
  addEndNodeExecution(run, graph, executionPath, nodeExecutions);

  // Calculate edge traversals based on execution path
  const edgeTraversals = calculateEdgeTraversals(executionPath, graph);

  const result: WorkflowRunExecution = {
    runId: run.runId,
    status: run.status,
    nodeExecutions,
    edgeTraversals,
    currentNode,
    executionPath,
  };

  console.log('[Graph Mapper] Mapping complete:', {
    executionPath,
    nodeExecutionsCount: nodeExecutions.size,
    nodeExecutions: Array.from(nodeExecutions.entries()).map(
      ([nodeId, execs]) => ({
        nodeId,
        executionCount: execs.length,
        latestStatus: execs[execs.length - 1]?.status,
      })
    ),
  });

  return result;
}
