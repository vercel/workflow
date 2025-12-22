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
 * Primitive node labels that correspond to event types
 */
const PRIMITIVE_LABELS = {
  sleep: 'sleep',
  createHook: 'createHook',
  createWebhook: 'createWebhook',
  awaitWebhook: 'awaitWebhook',
} as const;

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
  primitivesByLabel: Map<string, GraphNode[]>;
  agentNodes: GraphNode[];
  toolNodes: Map<string, GraphNode[]>;
} {
  const byStepId = new Map<string, GraphNode[]>();
  const byFunctionName = new Map<string, GraphNode[]>();
  const primitivesByLabel = new Map<string, GraphNode[]>();
  const agentNodes: GraphNode[] = [];
  const toolNodes = new Map<string, GraphNode[]>();

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

    // Index primitive nodes by their label
    if (node.data.nodeKind === 'primitive') {
      const label = node.data.label;
      const existing = primitivesByLabel.get(label) || [];
      existing.push(node);
      primitivesByLabel.set(label, existing);
    }

    // Index agent nodes (DurableAgent)
    if (node.data.nodeKind === 'agent') {
      agentNodes.push(node);
    }

    // Index tool nodes by their label (tool name)
    if (node.data.nodeKind === 'tool') {
      const label = node.data.label;
      // Extract base tool name (remove " (tool)" suffix if present)
      const toolName = label.replace(/ \(tool\)$/, '');
      const existing = toolNodes.get(toolName) || [];
      existing.push(node);
      toolNodes.set(toolName, existing);

      // Also index by function name from stepId for fallback matching
      if (node.data.stepId) {
        const functionName = extractFunctionName(
          normalizeStepName(node.data.stepId)
        );
        if (functionName) {
          const existingByName = toolNodes.get(functionName) || [];
          if (!existingByName.includes(node)) {
            existingByName.push(node);
            toolNodes.set(functionName, existingByName);
          }
        }
      }
    }
  }
  return { byStepId, byFunctionName, primitivesByLabel, agentNodes, toolNodes };
}

/**
 * Calculate edge traversals based on execution path and graph structure
 * Handles parallel operations (Promise.all, Promise.race, etc.) correctly
 */
function calculateEdgeTraversals(
  executionPath: string[],
  graph: WorkflowGraph,
  nodeExecutions: Map<string, StepExecution[]>
): Map<string, EdgeTraversal> {
  const edgeTraversals = new Map<string, EdgeTraversal>();

  // Build a set for quick lookup
  const executedNodes = new Set(executionPath);

  // Group nodes by parallelGroupId to understand parallel structure
  const parallelGroups = new Map<
    string,
    { nodes: typeof graph.nodes; method?: string }
  >();
  for (const node of graph.nodes) {
    const groupId = node.metadata?.parallelGroupId;
    if (groupId) {
      const existing = parallelGroups.get(groupId) || { nodes: [] };
      existing.nodes.push(node);
      existing.method = node.metadata?.parallelMethod;
      parallelGroups.set(groupId, existing);
    }
  }

  // Find the winner for each Promise.race group
  const raceWinners = new Map<string, string>(); // parallelGroupId -> winning nodeId
  for (const [groupId, group] of parallelGroups) {
    if (group.method === 'race') {
      let winnerNodeId: string | undefined;
      let earliestCompletion: Date | undefined;

      for (const node of group.nodes) {
        const executions = nodeExecutions.get(node.id);
        if (executions) {
          for (const exec of executions) {
            if (exec.status === 'completed' && exec.completedAt) {
              const completedAt = new Date(exec.completedAt);
              if (!earliestCompletion || completedAt < earliestCompletion) {
                earliestCompletion = completedAt;
                winnerNodeId = node.id;
              }
            }
          }
        }
      }

      if (winnerNodeId) {
        raceWinners.set(groupId, winnerNodeId);
      }
    }
  }

  // Mark edge as traversed helper
  const markEdgeTraversed = (edge: (typeof graph.edges)[0]) => {
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
  };

  // Process all edges
  for (const edge of graph.edges) {
    const sourceNode = graph.nodes.find((n) => n.id === edge.source);
    const targetNode = graph.nodes.find((n) => n.id === edge.target);

    if (!sourceNode || !targetNode) continue;

    const sourceExecuted = executedNodes.has(edge.source);
    const targetExecuted = executedNodes.has(edge.target);

    // If neither node was executed, skip
    if (!sourceExecuted && !targetExecuted) continue;

    // Handle conditional edges specially
    if (edge.type === 'conditional') {
      // Conditional edges should be marked as traversed if:
      // - The source (conditional node) was executed AND
      // - The target (branch node) was executed
      // The label ("true" or "false") indicates which branch
      if (sourceExecuted && targetExecuted) {
        markEdgeTraversed(edge);
      }
      continue;
    }

    // Check if source is part of a Promise.race group
    const sourceGroupId = sourceNode.metadata?.parallelGroupId;
    const sourceMethod = sourceNode.metadata?.parallelMethod;

    if (sourceGroupId && sourceMethod === 'race') {
      // For Promise.race: only mark edge from the winner as traversed
      const winner = raceWinners.get(sourceGroupId);
      if (winner === edge.source && targetExecuted) {
        markEdgeTraversed(edge);
      }
      // Don't mark edges from non-winners even if both nodes executed
    } else if (sourceExecuted && targetExecuted) {
      // For Promise.all/allSettled or regular edges: mark as traversed
      markEdgeTraversed(edge);
    } else if (sourceExecuted && edge.type === 'parallel') {
      // For edges going INTO parallel nodes, mark if source executed
      // and target is in the execution path
      if (targetExecuted) {
        markEdgeTraversed(edge);
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
        // No duration for control flow nodes (start/end/conditional)
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
      // No duration for control flow nodes (start/end/conditional)
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
 * Process primitive events (sleep, hooks) and map them to graph nodes
 */
function processPrimitiveEvents(
  events: Event[],
  primitivesByLabel: Map<string, GraphNode[]>,
  nodeExecutions: Map<string, StepExecution[]>,
  executionPath: string[]
): string | undefined {
  // Track occurrence counts for each primitive type
  const occurrenceCount = new Map<string, number>();

  // Group events by correlationId to pair created/completed events
  const eventsByCorrelation = new Map<string, Event[]>();
  for (const event of events) {
    if (!event.correlationId) continue;
    const existing = eventsByCorrelation.get(event.correlationId) || [];
    existing.push(event);
    eventsByCorrelation.set(event.correlationId, existing);
  }

  let currentNode: string | undefined;

  // Process sleep events (wait_created/wait_completed)
  const sleepNodes = primitivesByLabel.get(PRIMITIVE_LABELS.sleep) || [];
  const sleepCorrelations = new Set<string>();

  for (const event of events) {
    if (event.eventType === 'wait_created' && event.correlationId) {
      sleepCorrelations.add(event.correlationId);
    }
  }

  // Sort correlations by event creation time
  const sortedSleepCorrelations = Array.from(sleepCorrelations).sort((a, b) => {
    const eventsA = eventsByCorrelation.get(a) || [];
    const eventsB = eventsByCorrelation.get(b) || [];
    const timeA = eventsA.find(
      (e) => e.eventType === 'wait_created'
    )?.createdAt;
    const timeB = eventsB.find(
      (e) => e.eventType === 'wait_created'
    )?.createdAt;
    if (!timeA || !timeB) return 0;
    return new Date(timeA).getTime() - new Date(timeB).getTime();
  });

  for (const correlationId of sortedSleepCorrelations) {
    const correlationEvents = eventsByCorrelation.get(correlationId) || [];
    const createdEvent = correlationEvents.find(
      (e) => e.eventType === 'wait_created'
    );
    const completedEvent = correlationEvents.find(
      (e) => e.eventType === 'wait_completed'
    );

    if (!createdEvent) continue;

    // Find the corresponding node
    const occurrenceIndex = occurrenceCount.get(PRIMITIVE_LABELS.sleep) || 0;
    occurrenceCount.set(PRIMITIVE_LABELS.sleep, occurrenceIndex + 1);

    const graphNode =
      sleepNodes.length === 1 ? sleepNodes[0] : sleepNodes[occurrenceIndex];

    if (!graphNode) continue;

    // Determine status
    let status: StepExecution['status'] = 'running';
    if (completedEvent) {
      status = 'completed';
    }

    const startedAt = new Date(createdEvent.createdAt).toISOString();
    const completedAt = completedEvent
      ? new Date(completedEvent.createdAt).toISOString()
      : undefined;
    const duration = completedEvent
      ? new Date(completedEvent.createdAt).getTime() -
        new Date(createdEvent.createdAt).getTime()
      : undefined;

    const execution: StepExecution = {
      nodeId: graphNode.id,
      attemptNumber: 1,
      status,
      startedAt,
      completedAt,
      duration,
    };

    // Append or set executions
    const existing = nodeExecutions.get(graphNode.id) || [];
    nodeExecutions.set(graphNode.id, [...existing, execution]);

    if (!executionPath.includes(graphNode.id)) {
      executionPath.push(graphNode.id);
    }

    if (status === 'running') {
      currentNode = graphNode.id;
    }
  }

  // Process hook events (hook_created/hook_received)
  // createHook and createWebhook both use hook_created/hook_received events
  const hookNodes = [
    ...(primitivesByLabel.get(PRIMITIVE_LABELS.createHook) || []),
    ...(primitivesByLabel.get(PRIMITIVE_LABELS.createWebhook) || []),
  ];
  const hookCorrelations = new Set<string>();

  for (const event of events) {
    if (event.eventType === 'hook_created' && event.correlationId) {
      hookCorrelations.add(event.correlationId);
    }
  }

  // Sort correlations by event creation time
  const sortedHookCorrelations = Array.from(hookCorrelations).sort((a, b) => {
    const eventsA = eventsByCorrelation.get(a) || [];
    const eventsB = eventsByCorrelation.get(b) || [];
    const timeA = eventsA.find(
      (e) => e.eventType === 'hook_created'
    )?.createdAt;
    const timeB = eventsB.find(
      (e) => e.eventType === 'hook_created'
    )?.createdAt;
    if (!timeA || !timeB) return 0;
    return new Date(timeA).getTime() - new Date(timeB).getTime();
  });

  // Track hook occurrence separately from sleep
  let hookOccurrenceIndex = 0;

  for (const correlationId of sortedHookCorrelations) {
    const correlationEvents = eventsByCorrelation.get(correlationId) || [];
    const createdEvent = correlationEvents.find(
      (e) => e.eventType === 'hook_created'
    );

    if (!createdEvent) continue;

    // Find the corresponding node
    const graphNode =
      hookNodes.length === 1 ? hookNodes[0] : hookNodes[hookOccurrenceIndex];
    hookOccurrenceIndex++;

    if (!graphNode) continue;

    // Determine status - hooks are "completed" once created (the await is for received)
    // For the node visualization, we show it as completed when created
    const status: StepExecution['status'] = 'completed';

    const startedAt = new Date(createdEvent.createdAt).toISOString();
    const completedAt = new Date(createdEvent.createdAt).toISOString();

    const execution: StepExecution = {
      nodeId: graphNode.id,
      attemptNumber: 1,
      status,
      startedAt,
      completedAt,
      duration: 0,
    };

    // Append or set executions
    const existing = nodeExecutions.get(graphNode.id) || [];
    nodeExecutions.set(graphNode.id, [...existing, execution]);

    if (!executionPath.includes(graphNode.id)) {
      executionPath.push(graphNode.id);
    }
  }

  // Process awaitWebhook nodes - they wait for hook_received events
  const awaitWebhookNodes =
    primitivesByLabel.get(PRIMITIVE_LABELS.awaitWebhook) || [];

  // Track which hook correlations have been received
  const receivedHookCorrelations = new Set<string>();
  for (const event of events) {
    if (event.eventType === 'hook_received' && event.correlationId) {
      receivedHookCorrelations.add(event.correlationId);
    }
  }

  // Match awaitWebhook nodes with their corresponding hook events
  let awaitWebhookIndex = 0;
  for (const correlationId of sortedHookCorrelations) {
    const graphNode =
      awaitWebhookNodes.length === 1
        ? awaitWebhookNodes[0]
        : awaitWebhookNodes[awaitWebhookIndex];
    awaitWebhookIndex++;

    if (!graphNode) continue;

    const correlationEvents = eventsByCorrelation.get(correlationId) || [];
    const createdEvent = correlationEvents.find(
      (e) => e.eventType === 'hook_created'
    );
    const receivedEvent = correlationEvents.find(
      (e) => e.eventType === 'hook_received'
    );

    // Determine status based on whether hook was received
    let status: StepExecution['status'];
    let startedAt: string | undefined;
    let completedAt: string | undefined;
    let duration = 0;

    if (receivedEvent) {
      status = 'completed';
      startedAt = createdEvent
        ? new Date(createdEvent.createdAt).toISOString()
        : new Date(receivedEvent.createdAt).toISOString();
      completedAt = new Date(receivedEvent.createdAt).toISOString();
      duration =
        new Date(completedAt).getTime() - new Date(startedAt).getTime();
    } else if (createdEvent) {
      // Hook created but not yet received - running/waiting
      status = 'running';
      startedAt = new Date(createdEvent.createdAt).toISOString();
    } else {
      // No events yet - pending
      status = 'pending';
    }

    const execution: StepExecution = {
      nodeId: graphNode.id,
      attemptNumber: 1,
      status,
      startedAt,
      completedAt,
      duration,
    };

    const existing = nodeExecutions.get(graphNode.id) || [];
    nodeExecutions.set(graphNode.id, [...existing, execution]);

    if (!executionPath.includes(graphNode.id)) {
      executionPath.push(graphNode.id);
    }
  }

  return currentNode;
}

/**
 * Process agent and tool nodes - mark them as executed based on step executions
 * DurableAgent is marked as running/completed based on workflow status
 * Tool nodes are marked as executed when their corresponding step executes
 * Tools collection placeholders are marked based on agent status (since tools are dynamic)
 */
function processAgentAndToolNodes(
  run: WorkflowRun,
  steps: Step[],
  agentNodes: GraphNode[],
  toolNodes: Map<string, GraphNode[]>,
  nodeExecutions: Map<string, StepExecution[]>,
  executionPath: string[],
  allNodes: GraphNode[]
): void {
  // Determine agent status based on workflow status
  let agentStatus: StepExecution['status'] = 'pending';
  if (run.status === 'completed') {
    agentStatus = 'completed';
  } else if (run.status === 'failed') {
    agentStatus = 'failed';
  } else if (run.status === 'running') {
    agentStatus = 'running';
  }

  // Mark agent nodes as completed/running based on workflow status
  for (const agentNode of agentNodes) {
    const execution: StepExecution = {
      nodeId: agentNode.id,
      attemptNumber: 1,
      status: agentStatus,
      startedAt: run.startedAt
        ? new Date(run.startedAt).toISOString()
        : undefined,
      completedAt:
        run.completedAt &&
        (agentStatus === 'completed' || agentStatus === 'failed')
          ? new Date(run.completedAt).toISOString()
          : undefined,
    };

    nodeExecutions.set(agentNode.id, [execution]);

    if (!executionPath.includes(agentNode.id)) {
      executionPath.push(agentNode.id);
    }
  }

  // Map tool executions FIRST based on matching step names
  // Extract step function names and match to tool nodes
  for (const step of steps) {
    // Extract the function name from stepName (e.g., "step//...//searchFlights" -> "searchFlights")
    const functionName = extractFunctionName(step.stepName);
    if (!functionName) continue;

    // Check if this step matches any tool node
    const matchingToolNodes = toolNodes.get(functionName);
    if (!matchingToolNodes || matchingToolNodes.length === 0) continue;

    // Use the first matching tool node
    const toolNode = matchingToolNodes[0];

    // Map step status to execution status
    let status: StepExecution['status'];
    switch (step.status) {
      case 'completed':
        status = 'completed';
        break;
      case 'failed':
        status = 'failed';
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
      step.completedAt && step.startedAt
        ? new Date(step.completedAt).getTime() -
          new Date(step.startedAt).getTime()
        : undefined;

    const execution: StepExecution = {
      nodeId: toolNode.id,
      stepId: step.stepId,
      attemptNumber: step.attempt,
      status,
      startedAt: step.startedAt
        ? new Date(step.startedAt).toISOString()
        : undefined,
      completedAt: step.completedAt
        ? new Date(step.completedAt).toISOString()
        : undefined,
      duration,
      input: step.input,
      output: step.output,
      error: step.error,
    };

    // Append execution to existing or create new
    const existing = nodeExecutions.get(toolNode.id) || [];
    nodeExecutions.set(toolNode.id, [...existing, execution]);

    if (!executionPath.includes(toolNode.id)) {
      executionPath.push(toolNode.id);
    }
  }

  // After processing individual tool executions, mark any "tools collection" placeholder nodes
  // These are nodes representing unresolved imported tools objects (when we couldn't extract individual tools)
  // Individual tool nodes should only be marked if they were actually executed above
  for (const node of allNodes) {
    // Only mark tools collection placeholders, not individual tool nodes
    const isToolsCollection =
      (node.metadata as any)?.isToolsCollection === true;
    if (
      node.data.nodeKind === 'tool' &&
      isToolsCollection &&
      !nodeExecutions.has(node.id)
    ) {
      // This is a tools collection placeholder - mark based on agent status
      const execution: StepExecution = {
        nodeId: node.id,
        attemptNumber: 1,
        status: agentStatus,
        startedAt: run.startedAt
          ? new Date(run.startedAt).toISOString()
          : undefined,
        completedAt:
          run.completedAt &&
          (agentStatus === 'completed' || agentStatus === 'failed')
            ? new Date(run.completedAt).toISOString()
            : undefined,
      };

      nodeExecutions.set(node.id, [execution]);

      if (!executionPath.includes(node.id)) {
        executionPath.push(node.id);
      }
    }
  }
}

/**
 * Process conditional nodes - mark them as executed based on branch execution
 * If any node in a conditional branch was executed, the conditional node must have been evaluated
 */
function processConditionalNodes(
  graph: WorkflowGraph,
  nodeExecutions: Map<string, StepExecution[]>,
  executionPath: string[],
  run: WorkflowRun
): void {
  // Find all conditional nodes (decision points)
  const conditionalNodes = graph.nodes.filter(
    (n) => n.data.nodeKind === 'conditional'
  );

  // Group nodes by their conditionalId to find which branches were executed
  const nodesByConditionalId = new Map<
    string,
    { thenNodes: GraphNode[]; elseNodes: GraphNode[] }
  >();

  for (const node of graph.nodes) {
    const condId = node.metadata?.conditionalId;
    if (condId) {
      const group = nodesByConditionalId.get(condId) || {
        thenNodes: [],
        elseNodes: [],
      };
      if (node.metadata?.conditionalBranch === 'Then') {
        group.thenNodes.push(node);
      } else if (node.metadata?.conditionalBranch === 'Else') {
        group.elseNodes.push(node);
      }
      nodesByConditionalId.set(condId, group);
    }
  }

  // For each conditional node, check if any of its branch nodes were executed
  for (const condNode of conditionalNodes) {
    // Extract the conditionalId from the node id (e.g., "cond_0_node" -> "cond_0")
    const condIdMatch = condNode.id.match(/^(cond_\d+)_node$/);
    if (!condIdMatch) continue;

    const condId = condIdMatch[1];
    const branches = nodesByConditionalId.get(condId);
    if (!branches) continue;

    // Check if any node in either branch was executed
    const thenExecuted = branches.thenNodes.some((n) =>
      nodeExecutions.has(n.id)
    );
    const elseExecuted = branches.elseNodes.some((n) =>
      nodeExecutions.has(n.id)
    );

    // If either branch was executed, mark the conditional node as executed
    if (thenExecuted || elseExecuted) {
      const allBranchNodes = [...branches.thenNodes, ...branches.elseNodes];

      if (!nodeExecutions.has(condNode.id)) {
        // Find the earliest execution time from the branch nodes
        let earliestTime: string | undefined;
        for (const branchNode of allBranchNodes) {
          const execs = nodeExecutions.get(branchNode.id);
          if (execs && execs.length > 0) {
            const firstExec = execs[0];
            if (
              firstExec.startedAt &&
              (!earliestTime || firstExec.startedAt < earliestTime)
            ) {
              earliestTime = firstExec.startedAt;
            }
          }
        }

        const fallbackTime = run.startedAt
          ? new Date(run.startedAt).toISOString()
          : undefined;
        const execution: StepExecution = {
          nodeId: condNode.id,
          attemptNumber: 1,
          status: 'completed',
          startedAt: earliestTime || fallbackTime,
          completedAt: earliestTime || fallbackTime,
          // No duration for control flow nodes (start/end/conditional)
        };

        nodeExecutions.set(condNode.id, [execution]);
      }

      if (!executionPath.includes(condNode.id)) {
        // Insert conditional node before its branch nodes in the execution path
        const branchIndices = allBranchNodes
          .map((n) => executionPath.indexOf(n.id))
          .filter((i) => i >= 0);
        if (branchIndices.length > 0) {
          const firstBranchIndex = Math.min(...branchIndices);
          if (
            firstBranchIndex >= 0 &&
            firstBranchIndex < executionPath.length
          ) {
            executionPath.splice(firstBranchIndex, 0, condNode.id);
          } else {
            executionPath.push(condNode.id);
          }
        } else {
          executionPath.push(condNode.id);
        }
      }
    }
  }
}

/**
 * Maps a workflow run and its steps/events to an execution overlay for the graph
 */
export function mapRunToExecution(
  run: WorkflowRun,
  steps: Step[],
  events: Event[],
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

  // Build an index of graph nodes by normalized stepId, function name, and primitive label for quick lookup
  const {
    byStepId: nodesByStepId,
    byFunctionName: nodesByFunctionName,
    primitivesByLabel,
    agentNodes,
    toolNodes,
  } = buildNodeIndex(graph.nodes);

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

  // Process primitive events (sleep, createHook, createWebhook)
  const primitiveCurrentNode = processPrimitiveEvents(
    events,
    primitivesByLabel,
    nodeExecutions,
    executionPath
  );
  if (primitiveCurrentNode) {
    currentNode = primitiveCurrentNode;
  }

  // Process agent and tool nodes (DurableAgent and its tools)
  processAgentAndToolNodes(
    run,
    sortedSteps,
    agentNodes,
    toolNodes,
    nodeExecutions,
    executionPath,
    graph.nodes
  );

  // Process conditional nodes - mark them as executed if their branch nodes were executed
  processConditionalNodes(graph, nodeExecutions, executionPath, run);

  // Add end node based on workflow status
  addEndNodeExecution(run, graph, executionPath, nodeExecutions);

  // Calculate edge traversals based on execution path and node executions
  const edgeTraversals = calculateEdgeTraversals(
    executionPath,
    graph,
    nodeExecutions
  );

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
