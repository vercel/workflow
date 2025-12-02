'use client';

import {
  Background,
  Controls,
  type Edge,
  MarkerType,
  type Node,
  Panel,
  ReactFlow,
  useEdgesState,
  useNodesState,
} from '@xyflow/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import '@xyflow/react/dist/style.css';
import { GitBranch, Loader2, PlayCircle, StopCircle, X } from 'lucide-react';
import './workflow-graph-viewer.css';
import { type EnvMap, useWorkflowResourceData } from '@workflow/web-shared';
import { StatusBadge } from '@/components/display-utils/status-badge';
import { Badge } from '@/components/ui/badge';
import type {
  GraphNode,
  StepExecution,
  WorkflowGraph,
  WorkflowRunExecution,
} from '@/lib/workflow-graph-types';

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

// Custom node components
const nodeTypes = {};

// Get node styling based on node kind and execution state
function getNodeStyle(nodeKind: string, executions?: StepExecution[]) {
  const baseStyle = {
    color: 'hsl(var(--card-foreground))',
  };

  // Base colors for node types
  let baseColors = {
    background: 'rgba(96, 165, 250, 0.15)', // blue
    border: '#60a5fa',
  };

  if (nodeKind === 'workflow_start') {
    baseColors = {
      background: 'rgba(34, 197, 94, 0.15)', // green
      border: '#22c55e',
    };
  } else if (nodeKind === 'workflow_end') {
    baseColors = {
      background: 'rgba(148, 163, 184, 0.15)', // slate
      border: '#94a3b8',
    };
  }

  // If no execution data, show faded state
  if (!executions || executions.length === 0) {
    return {
      ...baseStyle,
      backgroundColor: baseColors.background,
      borderColor: baseColors.border,
      opacity: 0.4,
    };
  }

  const latestExecution = executions[executions.length - 1];

  // Override colors based on execution status (matching status-badge colors)
  switch (latestExecution.status) {
    case 'running':
      return {
        ...baseStyle,
        backgroundColor: 'rgba(59, 130, 246, 0.25)', // blue-500
        borderColor: '#3b82f6',
        borderWidth: 1.5,
        boxShadow: '0 0 0 2px rgba(59, 130, 246, 0.2)',
      };
    case 'completed':
      return {
        ...baseStyle,
        backgroundColor: 'rgba(16, 185, 129, 0.25)', // emerald-500
        borderColor: '#10b981',
      };
    case 'failed':
      return {
        ...baseStyle,
        backgroundColor: 'rgba(239, 68, 68, 0.25)', // red-500
        borderColor: '#ef4444',
        borderWidth: 1.5,
      };
    case 'retrying':
      return {
        ...baseStyle,
        backgroundColor: 'rgba(249, 115, 22, 0.25)', // orange-500
        borderColor: '#f97316',
        borderStyle: 'dashed',
      };
    case 'cancelled':
      return {
        ...baseStyle,
        backgroundColor: 'rgba(234, 179, 8, 0.25)', // yellow-500
        borderColor: '#eab308',
      };
    case 'pending':
      return {
        ...baseStyle,
        backgroundColor: baseColors.background,
        borderColor: baseColors.border,
        opacity: 0.6,
      };
    default:
      return {
        ...baseStyle,
        backgroundColor: baseColors.background,
        borderColor: baseColors.border,
      };
  }
}

// Get node icon based on node kind
function getNodeIcon(nodeKind: string) {
  if (nodeKind === 'workflow_start') {
    return (
      <PlayCircle className="h-3.5 w-3.5 text-green-600 dark:text-green-400" />
    );
  }
  if (nodeKind === 'workflow_end') {
    return (
      <StopCircle className="h-3.5 w-3.5 text-gray-600 dark:text-gray-400" />
    );
  }
  return <GitBranch className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

// Enhanced node label with execution info
function renderNodeLabel(
  nodeData: { label: string; nodeKind: string },
  metadata?: {
    loopId?: string;
    loopIsAwait?: boolean;
    conditionalId?: string;
    conditionalBranch?: string;
    parallelGroupId?: string;
    parallelMethod?: string;
  },
  executions?: StepExecution[]
) {
  // Add CFG metadata badges
  const badges: React.ReactNode[] = [];

  if (metadata?.loopId) {
    badges.push(
      <span
        key="loop"
        className="px-1.5 py-0.5 text-[10px] font-bold bg-purple-200 dark:bg-purple-900/30 !text-gray-950 dark:!text-white rounded border border-purple-400 dark:border-purple-700"
      >
        {metadata.loopIsAwait ? '⟳ await loop' : '⟳ loop'}
      </span>
    );
  }

  if (metadata?.conditionalId) {
    badges.push(
      <span
        key="cond"
        className="px-1.5 py-0.5 text-[10px] font-bold bg-amber-200 dark:bg-amber-900/30 !text-gray-950 dark:!text-white rounded border border-amber-400 dark:border-amber-700"
      >
        {metadata.conditionalBranch === 'Then' ? '✓ if' : '✗ else'}
      </span>
    );
  }

  if (metadata?.parallelGroupId) {
    const parallelLabel =
      metadata.parallelMethod === 'all'
        ? 'Promise.all'
        : metadata.parallelMethod === 'race'
          ? 'Promise.race'
          : metadata.parallelMethod === 'allSettled'
            ? 'Promise.allSettled'
            : `parallel: ${metadata.parallelMethod}`;
    badges.push(
      <span
        key="parallel"
        className="px-1.5 py-0.5 text-[10px] font-bold bg-blue-200 dark:bg-blue-900/30 !text-gray-950 dark:!text-white rounded border border-blue-400 dark:border-blue-700"
      >
        {parallelLabel}
      </span>
    );
  }

  const baseLabel = (
    <div className="flex flex-col gap-1.5 w-full overflow-hidden">
      <div className="flex items-start gap-2 w-full overflow-hidden">
        <div className="flex-shrink-0">{getNodeIcon(nodeData.nodeKind)}</div>
        <span className="text-sm font-medium break-words whitespace-normal leading-tight flex-1 min-w-0">
          {nodeData.label}
        </span>
      </div>
      {badges.length > 0 && (
        <div className="flex flex-wrap gap-1">{badges}</div>
      )}
    </div>
  );

  if (!executions || executions.length === 0) {
    return baseLabel;
  }

  const latestExecution = executions[executions.length - 1];
  const totalAttempts = executions.length;
  const hasRetries = totalAttempts > 1;

  return (
    <div className="flex flex-col gap-1.5 w-full">
      {baseLabel}

      {/* Execution metadata */}
      <div className="flex flex-wrap gap-1 text-xs">
        {/* Status badge */}
        <Badge
          variant={
            latestExecution.status === 'completed'
              ? 'default'
              : latestExecution.status === 'failed'
                ? 'destructive'
                : latestExecution.status === 'running'
                  ? 'secondary'
                  : latestExecution.status === 'cancelled'
                    ? 'outline'
                    : 'outline'
          }
          className="text-xs px-1.5 py-0"
        >
          {latestExecution.status}
        </Badge>

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
          <Badge variant="outline" className="text-xs px-1.5 py-0">
            ⏱ {formatDuration(latestExecution.duration)}
          </Badge>
        )}
      </div>
    </div>
  );
}

// Convert nodes with execution overlay
// Helper to calculate enhanced layout with control flow
function calculateEnhancedLayout(workflow: WorkflowGraph): {
  nodes: GraphNode[];
  additionalEdges: Array<{
    id: string;
    source: string;
    target: string;
    type: string;
    label?: string;
  }>;
} {
  // Clone nodes (positions are always provided by the manifest adapter)
  const nodes: GraphNode[] = workflow.nodes.map((node) => ({ ...node }));
  const additionalEdges: Array<{
    id: string;
    source: string;
    target: string;
    type: string;
    label?: string;
  }> = [];

  // Group nodes by their control flow context
  const parallelGroups = new Map<string, GraphNode[]>();
  const loopNodes = new Map<string, GraphNode[]>();
  const conditionalGroups = new Map<
    string,
    { thenBranch: GraphNode[]; elseBranch: GraphNode[] }
  >();

  for (const node of nodes) {
    if (node.metadata?.parallelGroupId) {
      const group = parallelGroups.get(node.metadata.parallelGroupId) || [];
      group.push(node);
      parallelGroups.set(node.metadata.parallelGroupId, group);
    }
    if (node.metadata?.loopId) {
      const group = loopNodes.get(node.metadata.loopId) || [];
      group.push(node);
      loopNodes.set(node.metadata.loopId, group);
    }
    if (node.metadata?.conditionalId) {
      const groups = conditionalGroups.get(node.metadata.conditionalId) || {
        thenBranch: [],
        elseBranch: [],
      };
      if (node.metadata.conditionalBranch === 'Then') {
        groups.thenBranch.push(node);
      } else {
        groups.elseBranch.push(node);
      }
      conditionalGroups.set(node.metadata.conditionalId, groups);
    }
  }

  // Layout parallel nodes side-by-side
  for (const [, groupNodes] of parallelGroups) {
    if (groupNodes.length <= 1) continue;

    const baseY = groupNodes[0].position.y;
    const spacing = 300; // horizontal spacing
    const totalWidth = (groupNodes.length - 1) * spacing;
    const startX = 250 - totalWidth / 2;

    groupNodes.forEach((node, idx) => {
      node.position = {
        x: startX + idx * spacing,
        y: baseY,
      };
    });
  }

  // Layout conditional branches side-by-side
  for (const [, branches] of conditionalGroups) {
    const allNodes = [...branches.thenBranch, ...branches.elseBranch];
    if (allNodes.length <= 1) continue;

    const thenNodes = branches.thenBranch;
    const elseNodes = branches.elseBranch;

    if (thenNodes.length > 0 && elseNodes.length > 0) {
      // Position then branch on the left, else on the right
      const baseY = Math.min(
        thenNodes[0]?.position.y || 0,
        elseNodes[0]?.position.y || 0
      );

      thenNodes.forEach((node, idx) => {
        node.position = {
          x: 100,
          y: baseY + idx * 120,
        };
      });

      elseNodes.forEach((node, idx) => {
        node.position = {
          x: 400,
          y: baseY + idx * 120,
        };
      });
    }
  }

  // Add loop-back edges
  for (const [loopId, loopNodeList] of loopNodes) {
    if (loopNodeList.length > 0) {
      // Find first and last nodes in the loop
      loopNodeList.sort((a, b) => {
        const aNum = parseInt(a.id.replace('node_', '')) || 0;
        const bNum = parseInt(b.id.replace('node_', '')) || 0;
        return aNum - bNum;
      });

      const firstNode = loopNodeList[0];
      const lastNode = loopNodeList[loopNodeList.length - 1];

      // Add a back edge from last to first
      // Note: no label needed - the nodes already show loop badges
      additionalEdges.push({
        id: `loop_back_${loopId}`,
        source: lastNode.id,
        target: firstNode.id,
        type: 'loop',
      });
    }
  }

  return { nodes, additionalEdges };
}

function convertToReactFlowNodes(
  workflow: WorkflowGraph,
  execution?: WorkflowRunExecution
): Node[] {
  const { nodes } = calculateEnhancedLayout(workflow);

  return nodes.map((node) => {
    const executions = execution?.nodeExecutions.get(node.id);
    const styles = getNodeStyle(node.data.nodeKind, executions);
    const isCurrentNode = execution?.currentNode === node.id;

    let nodeType: 'input' | 'output' | 'default' = 'default';
    if (node.type === 'workflowStart') {
      nodeType = 'input';
    } else if (node.type === 'workflowEnd') {
      nodeType = 'output';
    }

    return {
      id: node.id,
      type: nodeType,
      position: node.position,
      data: {
        ...node.data,
        label: renderNodeLabel(node.data, node.metadata, executions),
        executions, // Store for onClick handler
      },
      style: {
        borderWidth: 1,
        borderRadius: 8,
        padding: 12,
        width: 220,
        ...styles,
      },
      className: isCurrentNode ? 'animate-pulse-subtle' : '',
    };
  });
}

// Convert edges with execution overlay
function convertToReactFlowEdges(
  workflow: WorkflowGraph,
  execution?: WorkflowRunExecution
): Edge[] {
  const { additionalEdges } = calculateEnhancedLayout(workflow);

  // Combine original edges with additional loop-back edges
  const allEdges = [
    ...workflow.edges.map((e) => ({ ...e, isOriginal: true })),
    ...additionalEdges.map((e) => ({ ...e, isOriginal: false })),
  ];

  return allEdges.map((edge) => {
    const traversal = execution?.edgeTraversals.get(edge.id);
    const isTraversed = traversal && traversal.traversalCount > 0;

    // Calculate average timing if available
    const avgTiming = traversal?.timings.length
      ? traversal.timings.reduce((a, b) => a + b, 0) / traversal.timings.length
      : undefined;

    // Customize based on CFG edge type (but preserve execution state coloring)
    let baseStrokeColor = '#94a3b8';
    let strokeDasharray: string | undefined;
    let cfgLabel: string | undefined = edge.label;
    let edgeType: 'smoothstep' | 'straight' | 'step' = 'smoothstep';

    if (!isTraversed) {
      // Only apply CFG styling if not executed (to keep execution state clear)
      switch (edge.type) {
        case 'parallel':
          baseStrokeColor = '#3b82f6';
          strokeDasharray = '4,4';
          // No label needed - nodes have Promise.all/race/allSettled badges
          cfgLabel = undefined;
          break;
        case 'loop':
          baseStrokeColor = '#a855f7';
          strokeDasharray = '5,5';
          // Loop-back edges get a different path type for better visualization
          if (edge.source === edge.target || !edge.isOriginal) {
            edgeType = 'step';
          }
          // No label needed - nodes have loop badges
          cfgLabel = undefined;
          break;
        case 'conditional':
          baseStrokeColor = '#f59e0b';
          strokeDasharray = '8,4';
          // No label needed - nodes have if/else badges
          cfgLabel = undefined;
          break;
      }
    }

    const finalStrokeColor = isTraversed ? '#22c55e' : baseStrokeColor;
    const finalDasharray =
      traversal && traversal.traversalCount > 1 ? '5,5' : strokeDasharray;

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
                ~{formatDuration(avgTiming)}
              </span>
            )}
          </div>
        ) : (
          cfgLabel
        ),
      labelStyle: {
        fill: 'hsl(var(--foreground))',
        fontWeight: 500,
      },
      labelBgStyle: {
        fill: 'hsl(var(--background))',
        fillOpacity: 0.8,
      },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        width: 12,
        height: 12,
        color: finalStrokeColor,
      },
      style: {
        strokeWidth: isTraversed ? 1.5 : 1,
        stroke: finalStrokeColor,
        opacity: execution && !isTraversed ? 0.3 : 1,
        strokeDasharray: finalDasharray,
      },
    };
  });
}

// Format duration in a human-readable way
function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = ((ms % 60000) / 1000).toFixed(1);
  return `${minutes}m ${seconds}s`;
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
          {latestExecution?.duration !== undefined && (
            <span className="text-[10px] font-mono text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
              {formatDurationMs(latestExecution.duration)}
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
              {latestExecution.duration !== undefined && (
                <div className="flex items-center justify-between px-2.5 py-1.5">
                  <span className="text-[11px] font-medium text-muted-foreground">
                    duration
                  </span>
                  <span className="text-[11px] font-mono">
                    {formatDurationMs(latestExecution.duration)}
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
                      {exec.duration !== undefined && (
                        <span className="font-mono text-muted-foreground">
                          {formatDurationMs(exec.duration)}
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
          fitView
          minZoom={0.1}
          maxZoom={2}
          defaultViewport={{ x: 0, y: 0, zoom: 1 }}
          proOptions={{ hideAttribution: true }}
        >
          <Background />
          <Controls />

          {/* Legend with execution states (matching status-badge colors) */}
          <Panel
            position="top-left"
            className="bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 border rounded-lg p-2 text-xs"
          >
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-blue-500" />
                <span>Running</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-emerald-500" />
                <span>Completed</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-red-500" />
                <span>Failed</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-yellow-500" />
                <span>Canceled</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-orange-500" />
                <span>Paused</span>
              </div>
              <div className="flex items-center gap-2 opacity-50">
                <div className="w-3 h-3 rounded-full bg-gray-400" />
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
