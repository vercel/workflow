'use client';

import {
  Background,
  Controls,
  type Edge,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  Panel,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
} from '@xyflow/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import '@xyflow/react/dist/style.css';
import { GitBranch, Loader2, X } from 'lucide-react';
import './workflow-graph-viewer.css';
import {
  type EnvMap,
  formatDuration,
  useWorkflowResourceData,
} from '@workflow/web-shared';
import { StatusBadge } from '@/components/display-utils/status-badge';
import { Badge } from '@/components/ui/badge';
import type {
  GraphNode,
  StepExecution,
  WorkflowGraph,
  WorkflowRunExecution,
} from '@/lib/flow-graph/workflow-graph-types';
import {
  type ConsolidatedEdge,
  calculateEnhancedLayout,
  consolidateEdges,
  createEdgeTypes,
  type DiamondNodeData,
  type EnhancedLayoutResult,
  executionSelfLoopStyle,
  // Utilities
  getNodeBackgroundColor,
  getNodeIcon,
  // Constants
  LAYOUT,
  // Types
  type LoopNodeData,
  // Components
  ParallelGroupComponent,
  type ParallelGroupData,
} from './workflow-graph-viewer';

interface WorkflowGraphExecutionViewerProps {
  workflow: WorkflowGraph;
  execution?: WorkflowRunExecution;
  env?: EnvMap;
  onNodeClick?: (nodeId: string, executions: StepExecution[]) => void;
}

interface SelectedNodeInfo {
  nodeId: string;
  node: GraphNode;
  executions: StepExecution[];
  stepId?: string;
  runId?: string;
}

// Map execution status to StatusBadge-compatible status
type StatusBadgeStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'paused';
function mapToStatusBadgeStatus(
  status: StepExecution['status']
): StatusBadgeStatus {
  if (status === 'retrying') return 'running';
  return status as StatusBadgeStatus;
}

// Custom Loop Node component for execution viewer (uses shared LoopNodeData type)
function ExecutionLoopNodeComponent({ data, selected }: NodeProps) {
  const nodeData = data as LoopNodeData;

  return (
    <div
      className={`relative ${nodeData.className || ''}`}
      style={{
        borderWidth: nodeData.nodeStyle?.borderWidth ?? 2,
        borderRadius: 8,
        padding: 12,
        width: 220,
        borderStyle: 'solid',
        backgroundColor: nodeData.nodeStyle?.backgroundColor,
        borderColor: nodeData.nodeStyle?.borderColor ?? '#9ca3af',
        opacity: nodeData.nodeStyle?.opacity,
        boxShadow: selected ? '0 0 0 2px rgba(168, 85, 247, 0.5)' : undefined,
      }}
    >
      {/* Node content */}
      {nodeData.label}

      {/* Main flow handles (top/bottom) */}
      <Handle
        type="target"
        position={Position.Top}
        className="!bg-purple-500"
      />
      <Handle
        type="source"
        position={Position.Bottom}
        className="!bg-purple-500"
      />

      {/* Left-side handles for self-loop edge */}
      <Handle
        type="source"
        position={Position.Left}
        id="loop-out"
        className="!bg-purple-500 !-left-1 !w-[6px] !h-[6px] !min-w-0 !min-h-0"
        style={{ top: '30%' }}
      />
      <Handle
        type="target"
        position={Position.Left}
        id="loop-in"
        className="!bg-purple-500 !-left-1 !w-[6px] !h-[6px] !min-w-0 !min-h-0"
        style={{ top: '70%' }}
      />
    </div>
  );
}

// Custom node component for all non-loop execution nodes
function ExecutionNodeComponent({ data, selected }: NodeProps) {
  const nodeData = data as LoopNodeData; // Reuse LoopNodeData type since it has the same shape

  const isStart = nodeData.nodeKind === 'workflow_start';
  const isEnd = nodeData.nodeKind === 'workflow_end';

  return (
    <div
      className={`relative ${nodeData.className || ''}`}
      style={{
        borderWidth: nodeData.nodeStyle?.borderWidth ?? 2,
        borderRadius: 8,
        padding: 12,
        width: 220,
        borderStyle: 'solid',
        backgroundColor: nodeData.nodeStyle?.backgroundColor,
        borderColor: nodeData.nodeStyle?.borderColor ?? '#9ca3af',
        opacity: nodeData.nodeStyle?.opacity,
        boxShadow: selected ? '0 0 0 2px rgba(59, 130, 246, 0.35)' : undefined,
      }}
    >
      {nodeData.label}

      {/* Handles */}
      {!isStart && (
        <Handle type="target" position={Position.Top} className="!bg-muted" />
      )}
      {!isEnd && (
        <Handle
          type="source"
          position={Position.Bottom}
          className="!bg-muted"
        />
      )}
    </div>
  );
}

// Custom Diamond Node component for execution viewer conditional nodes
function ExecutionDiamondNodeComponent({ data, selected }: NodeProps) {
  const nodeData = data as DiamondNodeData;

  // Diamond size
  const size = 160;

  return (
    <div
      className={`relative flex items-center justify-center ${nodeData.className || ''}`}
      style={{
        width: size,
        height: size,
      }}
    >
      {/* Diamond shape */}
      <div
        style={{
          width: size * 0.7,
          height: size * 0.7,
          transform: 'rotate(45deg)',
          borderWidth: 2,
          borderStyle: 'solid',
          borderRadius: 4,
          backgroundColor: nodeData.nodeStyle?.backgroundColor,
          borderColor: nodeData.nodeStyle?.borderColor ?? '#ef4444',
          opacity: nodeData.nodeStyle?.opacity,
          boxShadow: selected ? '0 0 0 2px rgba(239, 68, 68, 0.5)' : undefined,
        }}
      />
      {/* Label overlay (not rotated) */}
      <div
        className="absolute inset-0 flex items-center justify-center pointer-events-auto"
        style={{
          fontSize: 11,
          fontWeight: 600,
          padding: size * 0.25, // Keep text within the diamond's inscribed area
        }}
        title={typeof nodeData.label === 'string' ? nodeData.label : undefined}
      >
        <span className="text-center line-clamp-3 overflow-hidden">
          {nodeData.label}
        </span>
      </div>

      {/* Main flow handles (top/bottom) */}
      <Handle type="target" position={Position.Top} className="!bg-red-500" />
      <Handle
        type="source"
        position={Position.Bottom}
        id="bottom"
        className="!bg-red-500"
      />
      {/* Additional handles for true/false branches */}
      <Handle
        type="source"
        position={Position.Left}
        id="left"
        className="!bg-red-500"
      />
      <Handle
        type="source"
        position={Position.Right}
        id="right"
        className="!bg-red-500"
      />
    </div>
  );
}

// Custom node components for execution viewer
const nodeTypes = {
  loopNode: ExecutionLoopNodeComponent,
  parallelGroup: ParallelGroupComponent, // Imported from shared
  executionNode: ExecutionNodeComponent,
  diamondNode: ExecutionDiamondNodeComponent,
};

// Custom edge types using purple styling for execution view
const edgeTypes = createEdgeTypes(executionSelfLoopStyle);

// Get node styling based on node kind and execution status (border color indicates status)
function getExecutionNodeStyle(nodeKind: string, executions?: StepExecution[]) {
  const backgroundColor = getNodeBackgroundColor(nodeKind);

  // If no execution data, show faded state with gray border
  if (!executions || executions.length === 0) {
    return {
      color: 'hsl(var(--card-foreground))',
      backgroundColor,
      borderColor: '#9ca3af', // gray-400
      opacity: 0.4,
    };
  }

  const latestExecution = executions[executions.length - 1];

  // Border color based on execution status
  let borderColor = '#9ca3af'; // gray-400 (default)
  let borderWidth = 2;

  switch (latestExecution.status) {
    case 'completed':
      borderColor = '#22c55e'; // green-500
      break;
    case 'failed':
      borderColor = '#ef4444'; // red-500
      borderWidth = 3;
      break;
    case 'running':
      borderColor = '#3b82f6'; // blue-500
      borderWidth = 2;
      break;
    case 'retrying':
      borderColor = '#f97316'; // orange-500
      break;
    case 'cancelled':
      borderColor = '#eab308'; // yellow-500
      break;
    case 'pending':
      borderColor = '#9ca3af'; // gray-400
      break;
  }

  return {
    color: 'hsl(var(--card-foreground))',
    backgroundColor,
    borderColor,
    borderWidth,
  };
}

// getNodeIcon is imported from workflow-graph-viewer

// Enhanced node label with execution info
function renderNodeLabel(
  nodeData: { label: string; nodeKind: string },
  _metadata?: {
    loopId?: string;
    loopIsAwait?: boolean;
    conditionalId?: string;
    conditionalBranch?: string;
    parallelGroupId?: string;
    parallelMethod?: string;
  },
  executions?: StepExecution[]
) {
  const baseLabel = (
    <div className="flex items-start gap-2 w-full overflow-hidden">
      <div className="flex-shrink-0">
        {getNodeIcon(nodeData.nodeKind, nodeData.label)}
      </div>
      <span className="text-sm font-medium break-words whitespace-normal leading-tight flex-1 min-w-0">
        {nodeData.label}
      </span>
    </div>
  );

  if (!executions || executions.length === 0) {
    return baseLabel;
  }

  const latestExecution = executions[executions.length - 1];
  const totalAttempts = executions.length;
  const hasRetries = totalAttempts > 1;

  // Only show metadata if there's something to show
  const hasMetadata =
    hasRetries || (latestExecution.duration && latestExecution.duration > 0);

  if (!hasMetadata) return baseLabel;

  return (
    <div className="flex flex-col gap-1.5 w-full">
      {baseLabel}

      {/* Execution metadata - only show duration and retries */}
      <div className="flex flex-wrap gap-1 text-xs">
        {/* Retry indicator */}
        {hasRetries && (
          <Badge
            variant="outline"
            className="text-xs px-1.5 py-0 border-orange-500 text-orange-700 dark:text-orange-300"
          >
            ↻ {totalAttempts}x
          </Badge>
        )}

        {/* Duration */}
        {latestExecution.duration && latestExecution.duration > 0 && (
          <Badge
            variant="secondary"
            className="text-xs px-1.5 py-0 bg-black/10 dark:bg-white/15 border-0"
          >
            ⏱ {formatDuration(latestExecution.duration, true)}
          </Badge>
        )}
      </div>
    </div>
  );
}

// LAYOUT and calculateEnhancedLayout are imported from workflow-graph-viewer
// Execution viewer uses VERTICAL_SPACING: 320 instead of default 220
const EXECUTION_LAYOUT = {
  ...LAYOUT,
  VERTICAL_SPACING: 320,
};

function convertToReactFlowNodes(
  workflow: WorkflowGraph,
  execution?: WorkflowRunExecution
): Node[] {
  const { nodes, groupNodes } = calculateEnhancedLayout(
    workflow,
    EXECUTION_LAYOUT
  );

  // Build a map of node id -> parent group id for parallel groups only
  const nodeToParent = new Map<string, string>();
  const groupPositions = new Map<string, { x: number; y: number }>();

  // Store group positions for relative position calculation (parallel groups only)
  for (const group of groupNodes) {
    if (group.id.startsWith('group_')) {
      groupPositions.set(group.id, group.position);
    }
  }

  // Determine parent for each node (parallel groups only, no loop groups)
  for (const node of nodes) {
    const parallelGroupId = node.metadata?.parallelGroupId
      ? `group_${node.metadata.parallelGroupId}`
      : null;

    if (parallelGroupId && groupPositions.has(parallelGroupId)) {
      nodeToParent.set(node.id, parallelGroupId);
    }
  }

  const reactFlowNodes: Node[] = [];

  // Add parallel groups only (no loop groups)
  const parallelGroups = groupNodes.filter((g) => g.id.startsWith('group_'));

  for (const group of parallelGroups) {
    reactFlowNodes.push({
      id: group.id,
      type: 'parallelGroup',
      position: group.position,
      style: {
        ...group.style,
        cursor: 'grab',
        zIndex: -1,
      },
      data: group.data,
      selectable: true,
      draggable: true,
    });
  }

  // Add regular nodes
  for (const node of nodes) {
    const executions = execution?.nodeExecutions.get(node.id);
    const styles = getExecutionNodeStyle(node.data.nodeKind, executions);
    const isCurrentNode = execution?.currentNode === node.id;
    const isLoopNode = !!node.metadata?.loopId;
    const isAwaitLoop = !!node.metadata?.loopIsAwait;
    const isConditionalNode = node.data.nodeKind === 'conditional';

    // Determine node type - custom components for consistent styling/animation
    const nodeType: 'loopNode' | 'executionNode' | 'diamondNode' =
      isConditionalNode
        ? 'diamondNode'
        : isLoopNode
          ? 'loopNode'
          : 'executionNode';

    // Determine parent group and calculate relative position
    const parentId = nodeToParent.get(node.id);
    let position = node.position;

    if (parentId) {
      const parentPos = groupPositions.get(parentId);
      if (parentPos) {
        // Convert to relative position within parent
        position = {
          x: node.position.x - parentPos.x,
          y: node.position.y - parentPos.y,
        };
      }
    }

    // Build className for current node highlight
    const nodeClassName = isCurrentNode ? 'animate-pulse-subtle' : '';

    // For loop nodes, pass style through data for custom component
    if (isLoopNode) {
      reactFlowNodes.push({
        id: node.id,
        type: nodeType,
        position,
        parentId: parentId,
        extent: parentId ? 'parent' : undefined,
        expandParent: true,
        data: {
          ...node.data,
          label: renderNodeLabel(node.data, node.metadata, executions),
          executions,
          isLoopNode: true,
          isAwaitLoop,
          nodeStyle: styles,
          className: nodeClassName,
        },
      });
    } else if (isConditionalNode) {
      // For conditional nodes (diamond shape), pass style through data
      reactFlowNodes.push({
        id: node.id,
        type: nodeType,
        position,
        parentId: parentId,
        extent: parentId ? 'parent' : undefined,
        expandParent: true,
        data: {
          ...node.data,
          label: node.data.label, // Show the conditional expression
          executions,
          nodeStyle: styles,
          className: nodeClassName,
        },
      });
    } else {
      reactFlowNodes.push({
        id: node.id,
        type: nodeType,
        position,
        parentId: parentId,
        extent: parentId ? 'parent' : undefined,
        expandParent: true,
        data: {
          ...node.data,
          label: renderNodeLabel(node.data, node.metadata, executions),
          executions,
          nodeStyle: styles,
          className: nodeClassName,
        },
        // Styling is handled by ExecutionNodeComponent (keeps running animation behind background)
        style: { width: 220 },
      });
    }
  }

  return reactFlowNodes;
}

// ConsolidatedEdge type and consolidateEdges are imported from workflow-graph-viewer

// Convert edges with execution overlay
function convertToReactFlowEdges(
  workflow: WorkflowGraph,
  execution?: WorkflowRunExecution
): Edge[] {
  const { additionalEdges } = calculateEnhancedLayout(
    workflow,
    EXECUTION_LAYOUT
  );

  // Transform original loop edges into loop_back_ edges (they go from exit nodes back to entry nodes)
  // and keep all other edges as-is
  const transformedOriginalEdges = workflow.edges.map((e) => {
    if (e.type === 'loop') {
      return {
        ...e,
        id: `loop_back_${e.source}_${e.target}`,
        isOriginal: true,
      };
    }
    return { ...e, isOriginal: true };
  });

  // Combine original edges with additional self-loop edges
  const rawEdges = [
    ...transformedOriginalEdges,
    ...additionalEdges.map((e) => ({ ...e, isOriginal: false })),
  ];

  // Consolidate N×M edges between parallel groups into single edges
  const allEdges = consolidateEdges(rawEdges, workflow.nodes);

  return allEdges.map((edge) => {
    // Handle self-loop edges specially (they use custom edge type and handles)
    if (edge.type === 'selfLoop') {
      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        sourceHandle: edge.sourceHandle,
        targetHandle: edge.targetHandle,
        type: 'selfLoop',
        label: edge.label,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 12,
          height: 12,
          color: '#a855f7',
        },
      };
    }

    // For consolidated edges, check traversals of original edges
    let traversal = execution?.edgeTraversals.get(edge.id);
    if (!traversal && edge.isConsolidated && edge.originalEdgeIds) {
      // Check if any of the original edges were traversed
      for (const originalId of edge.originalEdgeIds) {
        const originalTraversal = execution?.edgeTraversals.get(originalId);
        if (originalTraversal && originalTraversal.traversalCount > 0) {
          // Use the first traversed original edge's data
          traversal = originalTraversal;
          break;
        }
      }
    }
    const isTraversed = traversal && traversal.traversalCount > 0;
    const hasExecution = !!execution;

    // Calculate average timing if available
    const avgTiming = traversal?.timings.length
      ? traversal.timings.reduce((a, b) => a + b, 0) / traversal.timings.length
      : undefined;

    // Determine edge type based on control flow
    // Use bezier for main flow (cleaner curves), step for loops (clear back-flow)
    let edgeType: 'bezier' | 'smoothstep' | 'step' = 'bezier';
    let strokeDasharray: string | undefined;
    let cfgLabel: string | undefined = edge.label;

    // Track if this is a conditional edge for special label styling
    let isConditional = false;

    switch (edge.type) {
      case 'parallel':
        edgeType = 'smoothstep';
        strokeDasharray = '4,4';
        cfgLabel = undefined;
        break;
      case 'loop':
        edgeType = 'step';
        strokeDasharray = '8,4';
        break;
      case 'conditional':
        edgeType = 'smoothstep';
        strokeDasharray = '8,4';
        isConditional = true;
        // Keep the edge label (e.g., "true" or "false") for conditional edges
        break;
      default:
        edgeType = 'bezier';
    }

    // Simple color scheme: gray for non-executed, dark green for executed
    const baseStrokeColor = '#6b7280'; // gray-500
    const finalStrokeColor = isTraversed ? '#22c55e' : baseStrokeColor;
    const finalDasharray = isTraversed ? undefined : strokeDasharray;

    // Make non-traversed edges subtle when there's execution data
    const opacity = hasExecution && !isTraversed ? 0.35 : 1;
    const strokeWidth = isTraversed ? 2.5 : 1;

    // Label styling - conditional edges get dark bg with white text
    const labelTextColor = isConditional ? '#ffffff' : '#6b7280';
    const labelBgColor = isConditional ? '#374151' : '#f3f4f6'; // gray-700 : gray-100
    const labelBorderColor = isConditional ? '#4b5563' : '#d1d5db'; // gray-600 : gray-300

    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: edgeType,
      animated: isTraversed && execution?.status === 'running',
      label:
        traversal && traversal.traversalCount > 1 ? (
          <div className="flex flex-col items-center gap-0.5">
            <Badge variant="secondary" className="text-xs px-1.5 py-0">
              {traversal.traversalCount}×
            </Badge>
            {avgTiming && avgTiming > 0 && (
              <span className="text-[10px] text-muted-foreground">
                ~{formatDuration(avgTiming, true)}
              </span>
            )}
          </div>
        ) : (
          cfgLabel
        ),
      labelStyle: {
        fill: labelTextColor,
        fontWeight: 500,
        fontSize: '11px',
      },
      labelBgStyle: {
        fill: labelBgColor,
        fillOpacity: 0.95,
        stroke: labelBorderColor,
        strokeWidth: 1,
      },
      labelBgPadding: [4, 6] as [number, number],
      labelBgBorderRadius: 4,
      markerEnd: {
        type: MarkerType.ArrowClosed,
        width: isTraversed ? 14 : 10,
        height: isTraversed ? 14 : 10,
        color: finalStrokeColor,
      },
      style: {
        strokeWidth,
        stroke: finalStrokeColor,
        opacity,
        strokeDasharray: finalDasharray,
      },
    };
  });
}

// Node Detail Panel Component
function GraphNodeDetailPanel({
  selectedNode,
  env,
  onClose,
}: {
  selectedNode: SelectedNodeInfo;
  env?: EnvMap;
  onClose: () => void;
}) {
  const { node, executions, stepId, runId } = selectedNode;
  const latestExecution = executions[executions.length - 1];
  const hasMultipleAttempts = executions.length > 1;

  // Fetch full step data with resolved input/output
  const { data: stepData, loading: stepLoading } = useWorkflowResourceData(
    env ?? {},
    'step',
    stepId ?? '',
    { runId }
  );

  // Use fetched data for input/output if available, fallback to execution data
  const resolvedInput = (stepData as any)?.input ?? latestExecution?.input;
  const resolvedOutput = (stepData as any)?.output ?? latestExecution?.output;
  const resolvedError = (stepData as any)?.error ?? latestExecution?.error;

  return (
    <div className="h-full flex flex-col bg-background border-l">
      {/* Header - similar to trace view */}
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b flex-none">
        <span
          className="text-xs font-medium truncate flex-1"
          title={node.data.label}
        >
          {node.data.label}
        </span>
        <div className="flex items-center gap-2 flex-none">
          {latestExecution?.duration !== undefined &&
            latestExecution.duration > 0 && (
              <span className="text-[10px] font-mono text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                {formatDuration(latestExecution.duration)}
              </span>
            )}
          <div className="w-px h-4 bg-border" />
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded hover:bg-muted transition-colors"
            aria-label="Close panel"
          >
            <X className="h-4 w-4 text-muted-foreground" />
          </button>
        </div>
      </div>

      {/* Content - scrollable */}
      <div className="flex-1 overflow-y-auto p-3 min-h-0">
        {/* Basic attributes in bordered container */}
        <div className="flex flex-col divide-y rounded-lg border overflow-hidden mb-3">
          <div className="flex items-center justify-between px-2.5 py-1.5">
            <span className="text-[11px] font-medium text-muted-foreground">
              type
            </span>
            <span className="text-[11px] font-mono">{node.data.nodeKind}</span>
          </div>
          {latestExecution && (
            <>
              <div className="flex items-center justify-between px-2.5 py-1.5">
                <span className="text-[11px] font-medium text-muted-foreground">
                  status
                </span>
                <StatusBadge
                  status={mapToStatusBadgeStatus(latestExecution.status)}
                />
              </div>
              {latestExecution.duration !== undefined &&
                latestExecution.duration > 0 && (
                  <div className="flex items-center justify-between px-2.5 py-1.5">
                    <span className="text-[11px] font-medium text-muted-foreground">
                      duration
                    </span>
                    <span className="text-[11px] font-mono">
                      {formatDuration(latestExecution.duration)}
                    </span>
                  </div>
                )}
              {hasMultipleAttempts && (
                <div className="flex items-center justify-between px-2.5 py-1.5">
                  <span className="text-[11px] font-medium text-muted-foreground">
                    attempts
                  </span>
                  <span className="text-[11px] font-mono">
                    {executions.length}
                  </span>
                </div>
              )}
              {latestExecution.startedAt && (
                <div className="flex items-center justify-between px-2.5 py-1.5">
                  <span className="text-[11px] font-medium text-muted-foreground">
                    startedAt
                  </span>
                  <span className="text-[11px] font-mono">
                    {new Date(latestExecution.startedAt).toLocaleString()}
                  </span>
                </div>
              )}
              {latestExecution.completedAt && (
                <div className="flex items-center justify-between px-2.5 py-1.5">
                  <span className="text-[11px] font-medium text-muted-foreground">
                    completedAt
                  </span>
                  <span className="text-[11px] font-mono">
                    {new Date(latestExecution.completedAt).toLocaleString()}
                  </span>
                </div>
              )}
            </>
          )}
        </div>

        {/* Loading indicator for resolved data */}
        {stepLoading && stepId && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground mb-3">
            <Loader2 className="h-3 w-3 animate-spin" />
            <span>Loading step data...</span>
          </div>
        )}

        {/* Input section */}
        {resolvedInput !== undefined && (
          <details className="group mb-3">
            <summary className="cursor-pointer rounded-md border px-2.5 py-1.5 text-xs hover:brightness-95 bg-muted/50">
              <span className="font-medium">Input</span>
              <span className="text-muted-foreground ml-1">
                ({Array.isArray(resolvedInput) ? resolvedInput.length : 1} args)
              </span>
            </summary>
            <div className="relative pl-6 mt-3">
              <div className="absolute left-3 -top-3 w-px h-3 bg-border" />
              <div className="absolute left-3 top-0 w-3 h-3 border-l border-b rounded-bl-lg border-border" />
              <pre className="text-[11px] overflow-x-auto rounded-md border p-2.5 bg-muted/30 max-h-64 overflow-y-auto">
                <code>{JSON.stringify(resolvedInput, null, 2)}</code>
              </pre>
            </div>
          </details>
        )}

        {/* Output section */}
        {resolvedOutput !== undefined && (
          <details className="group mb-3">
            <summary className="cursor-pointer rounded-md border px-2.5 py-1.5 text-xs hover:brightness-95 bg-muted/50">
              <span className="font-medium">Output</span>
            </summary>
            <div className="relative pl-6 mt-3">
              <div className="absolute left-3 -top-3 w-px h-3 bg-border" />
              <div className="absolute left-3 top-0 w-3 h-3 border-l border-b rounded-bl-lg border-border" />
              <pre className="text-[11px] overflow-x-auto rounded-md border p-2.5 bg-muted/30 max-h-64 overflow-y-auto">
                <code>{JSON.stringify(resolvedOutput, null, 2)}</code>
              </pre>
            </div>
          </details>
        )}

        {/* Error section */}
        {resolvedError && (
          <details className="group mb-3" open>
            <summary className="cursor-pointer rounded-md border border-red-300 bg-red-50 dark:bg-red-950/20 px-2.5 py-1.5 text-xs hover:brightness-95">
              <span className="font-medium text-red-600 dark:text-red-400">
                Error
              </span>
            </summary>
            <div className="relative pl-6 mt-3">
              <div className="absolute left-3 -top-3 w-px h-3 bg-red-300" />
              <div className="absolute left-3 top-0 w-3 h-3 border-l border-b rounded-bl-lg border-red-300" />
              <pre className="text-[11px] overflow-x-auto rounded-md border border-red-200 p-2.5 bg-red-50 dark:bg-red-950/20 text-red-700 dark:text-red-300 whitespace-pre-wrap max-h-64 overflow-y-auto">
                <code>
                  {typeof resolvedError === 'object'
                    ? JSON.stringify(resolvedError, null, 2)
                    : String(resolvedError)}
                </code>
              </pre>
            </div>
          </details>
        )}

        {/* Attempt history for retries */}
        {hasMultipleAttempts && (
          <details className="group">
            <summary className="cursor-pointer rounded-md border px-2.5 py-1.5 text-xs hover:brightness-95 bg-muted/50">
              <span className="font-medium">Attempt History</span>
              <span className="text-muted-foreground ml-1">
                ({executions.length} attempts)
              </span>
            </summary>
            <div className="relative pl-6 mt-3">
              <div className="absolute left-3 -top-3 w-px h-3 bg-border" />
              <div className="absolute left-3 top-0 w-3 h-3 border-l border-b rounded-bl-lg border-border" />
              <div className="flex flex-col divide-y rounded-md border overflow-hidden">
                {executions.map((exec) => (
                  <div
                    key={exec.attemptNumber}
                    className="flex items-center justify-between px-2.5 py-1.5 text-[11px]"
                  >
                    <span className="text-muted-foreground">
                      Attempt {exec.attemptNumber}
                    </span>
                    <div className="flex items-center gap-2">
                      <StatusBadge
                        status={mapToStatusBadgeStatus(exec.status)}
                      />
                      {exec.duration !== undefined && exec.duration > 0 && (
                        <span className="font-mono text-muted-foreground">
                          {formatDuration(exec.duration)}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </details>
        )}
      </div>
    </div>
  );
}

export function WorkflowGraphExecutionViewer({
  workflow,
  execution,
  env,
  onNodeClick,
}: WorkflowGraphExecutionViewerProps) {
  const [selectedNode, setSelectedNode] = useState<SelectedNodeInfo | null>(
    null
  );
  const panelWidth = 320;

  const initialNodes = useMemo(
    () => convertToReactFlowNodes(workflow, execution),
    [workflow, execution]
  );
  const initialEdges = useMemo(
    () => convertToReactFlowEdges(workflow, execution),
    [workflow, execution]
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  // Update nodes and edges when workflow or execution changes
  // Preserve user-dragged positions by merging with current node positions
  useEffect(() => {
    setNodes((currentNodes) => {
      const newNodes = convertToReactFlowNodes(workflow, execution);
      // Create a map of current positions (user may have dragged nodes)
      const currentPositions = new Map(
        currentNodes.map((n) => [n.id, n.position])
      );
      // Merge new node data with existing positions
      return newNodes.map((node) => ({
        ...node,
        position: currentPositions.get(node.id) ?? node.position,
      }));
    });
    setEdges(convertToReactFlowEdges(workflow, execution));
  }, [workflow, execution, setNodes, setEdges]);

  const handleNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      const graphNode = workflow.nodes.find((n) => n.id === node.id);
      if (graphNode) {
        const executions = (node.data.executions as StepExecution[]) || [];
        const latestExecution = executions[executions.length - 1];
        setSelectedNode({
          nodeId: node.id,
          node: graphNode,
          executions,
          stepId: latestExecution?.stepId,
          runId: execution?.runId,
        });
        // Also call the external handler if provided
        if (onNodeClick && executions.length > 0) {
          onNodeClick(node.id, executions);
        }
      }
    },
    [workflow.nodes, execution?.runId, onNodeClick]
  );

  const handleClosePanel = useCallback(() => {
    setSelectedNode(null);
  }, []);

  return (
    <div className="h-full w-full border rounded-lg bg-background relative overflow-hidden flex">
      {/* Graph canvas */}
      <div
        className="h-full flex-1 min-w-0"
        style={{
          width: selectedNode ? `calc(100% - ${panelWidth}px)` : '100%',
        }}
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={handleNodeClick}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          fitView
          minZoom={0.1}
          maxZoom={2}
          defaultViewport={{ x: 0, y: 0, zoom: 1 }}
          proOptions={{ hideAttribution: true }}
        >
          <Background />
          <Controls />

          {/* Legend with border status colors */}
          <Panel
            position="top-left"
            className="bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 border rounded-lg p-2 text-xs"
          >
            <div className="space-y-1.5">
              <div className="font-semibold text-[10px] text-muted-foreground mb-1">
                Status
              </div>
              <div className="flex items-center gap-2">
                <div className="w-6 h-4 rounded border-2 border-green-500 bg-background" />
                <span>Completed</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-6 h-4 rounded border-2 border-red-500 bg-background" />
                <span>Failed</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-6 h-4 rounded border-2 border-blue-500 bg-background" />
                <span>Running</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-6 h-4 rounded border-2 border-yellow-500 bg-background" />
                <span>Cancelled</span>
              </div>
              <div className="flex items-center gap-2 opacity-50">
                <div className="w-6 h-4 rounded border-2 border-gray-400 bg-background" />
                <span>Pending</span>
              </div>
            </div>
          </Panel>

          {/* Execution summary panel */}
          {execution && (
            <Panel
              position="top-right"
              className="bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 border rounded-lg p-3 text-xs space-y-1.5"
            >
              <div className="font-semibold text-sm">Execution</div>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">Status:</span>
                <Badge
                  variant={
                    execution.status === 'completed'
                      ? 'default'
                      : execution.status === 'failed'
                        ? 'destructive'
                        : execution.status === 'cancelled'
                          ? 'outline'
                          : 'secondary'
                  }
                  className="text-xs"
                >
                  {execution.status}
                </Badge>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">Progress:</span>
                <span className="font-mono">
                  {execution.executionPath.length} / {workflow.nodes.length}
                </span>
              </div>
            </Panel>
          )}
        </ReactFlow>
      </div>

      {/* Detail panel */}
      {selectedNode && (
        <div className="h-full flex-none" style={{ width: panelWidth }}>
          <GraphNodeDetailPanel
            selectedNode={selectedNode}
            env={env}
            onClose={handleClosePanel}
          />
        </div>
      )}
    </div>
  );
}
