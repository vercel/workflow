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
 * Raw manifest types matching the JSON structure from the SWC plugin.
 * We support two formats:
 * - Legacy (pre-1.0.0): file-path keyed structure
 * - New (1.0.0+): ID-keyed structure with exports
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

/**
 * Legacy format (pre-1.0.0): workflows keyed by file path, then by function name
 * { [filePath]: { [workflowName]: { workflowId, graph } } }
 */
export interface LegacyManifestWorkflowEntry {
  workflowId: string;
  graph: {
    nodes: RawGraphNode[];
    edges: GraphEdge[];
  };
}

export interface LegacyWorkflowsManifest {
  version?: string;
  steps?: Record<string, Record<string, RawManifestStep>>;
  workflows?: Record<string, Record<string, LegacyManifestWorkflowEntry>>;
}

/**
 * New format (1.0.0+): workflows keyed by workflow ID
 * { [workflowId]: { workflowId, name, exports, graph } }
 */
export interface NewManifestWorkflowEntry {
  workflowId: string;
  name: string;
  exports: Record<string, string>;
  graph?: {
    nodes: RawGraphNode[];
    edges: GraphEdge[];
  };
}

export interface NewWorkflowsManifest {
  version: string;
  steps?: Record<
    string,
    { stepId: string; name: string; exports: Record<string, string> }
  >;
  workflows?: Record<string, NewManifestWorkflowEntry>;
  classes?: Record<
    string,
    { classId: string; name: string; exports: Record<string, string> }
  >;
}

/**
 * Union type for raw manifest - can be either legacy or new format
 */
export type RawWorkflowsManifest =
  | LegacyWorkflowsManifest
  | NewWorkflowsManifest;

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
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  nodeExecutions: Map<string, StepExecution[]>; // nodeId -> array of executions (for retries)
  edgeTraversals: Map<string, EdgeTraversal>; // edgeId -> traversal info
  currentNode?: string; // for running workflows
  executionPath: string[]; // ordered list of nodeIds
}
