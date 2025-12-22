/**
 * Types for workflow graph visualization
 * These types represent the processed/adapted format used by UI components.
 * The manifest adapter transforms the raw SWC plugin output into this format.
 */

export interface Position {
  x: number;
  y: number;
}

export interface NodeMetadata {
  loopId?: string;
  loopIsAwait?: boolean;
  conditionalId?: string;
  conditionalBranch?: 'Then' | 'Else';
  parallelGroupId?: string;
  parallelMethod?: 'all' | 'race' | 'allSettled';
}

export interface NodeData {
  label: string;
  nodeKind:
    | 'workflow_start'
    | 'workflow_end'
    | 'step'
    | 'primitive'
    | 'conditional'
    | 'agent'
    | 'tool';
  stepId?: string;
}

export interface GraphNode {
  id: string;
  type: string;
  position: Position;
  data: NodeData;
  metadata?: NodeMetadata;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: 'default' | 'loop' | 'conditional' | 'parallel' | 'tool';
  label?: string;
}

export interface WorkflowGraph {
  workflowId: string;
  workflowName: string;
  filePath: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface WorkflowGraphManifest {
  version: string;
  workflows: Record<string, WorkflowGraph>;
}

/**
 * Raw manifest types matching the new JSON structure from the SWC plugin
 */
export interface RawManifestStep {
  stepId: string;
}

export interface RawGraphNode {
  id: string;
  type: string;
  data: {
    label: string;
    nodeKind: string;
    stepId?: string;
  };
  metadata?: NodeMetadata;
}

export interface RawManifestWorkflowEntry {
  workflowId: string;
  graph: {
    nodes: RawGraphNode[];
    edges: GraphEdge[];
  };
}

export interface RawWorkflowsManifest {
  version: string;
  steps: Record<string, Record<string, RawManifestStep>>;
  workflows: Record<string, Record<string, RawManifestWorkflowEntry>>;
}

/**
 * Types for overlaying execution data on workflow graphs
 */

export interface StepExecution {
  nodeId: string;
  stepId?: string;
  attemptNumber: number;
  status:
    | 'pending'
    | 'running'
    | 'completed'
    | 'failed'
    | 'retrying'
    | 'cancelled';
  startedAt?: string;
  completedAt?: string;
  duration?: number;
  input?: unknown;
  output?: unknown;
  error?: { message: string; stack?: string; code?: string };
}

export interface EdgeTraversal {
  edgeId: string;
  traversalCount: number;
  lastTraversedAt?: string;
  timings: number[]; // time taken to traverse (ms)
}

export interface WorkflowRunExecution {
  runId: string;
  status:
    | 'pending'
    | 'running'
    | 'completed'
    | 'failed'
    | 'paused'
    | 'cancelled';
  nodeExecutions: Map<string, StepExecution[]>; // nodeId -> array of executions (for retries)
  edgeTraversals: Map<string, EdgeTraversal>; // edgeId -> traversal info
  currentNode?: string; // for running workflows
  executionPath: string[]; // ordered list of nodeIds
}
