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
import { useCallback, useEffect, useMemo } from 'react';
import '@xyflow/react/dist/style.css';
import { GitBranch, PlayCircle, StopCircle } from 'lucide-react';
import './workflow-graph-viewer.css';
import { Badge } from '@/components/ui/badge';
import type {
  StepExecution,
  WorkflowGraph,
  WorkflowRunExecution,
} from '@/lib/workflow-graph-types';

interface WorkflowGraphExecutionViewerProps {
  workflow: WorkflowGraph;
  execution?: WorkflowRunExecution;
  onNodeClick?: (nodeId: string, executions: StepExecution[]) => void;
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

  // Override colors based on execution status
  switch (latestExecution.status) {
    case 'running':
      return {
        ...baseStyle,
        backgroundColor: 'rgba(251, 191, 36, 0.25)', // amber
        borderColor: '#f59e0b',
        borderWidth: 3,
        boxShadow: '0 0 0 3px rgba(251, 191, 36, 0.2)',
      };
    case 'completed':
      return {
        ...baseStyle,
        backgroundColor: 'rgba(34, 197, 94, 0.25)', // green
        borderColor: '#22c55e',
        borderWidth: 2,
      };
    case 'failed':
      return {
        ...baseStyle,
        backgroundColor: 'rgba(239, 68, 68, 0.25)', // red
        borderColor: '#ef4444',
        borderWidth: 3,
      };
    case 'retrying':
      return {
        ...baseStyle,
        backgroundColor: 'rgba(249, 115, 22, 0.25)', // orange
        borderColor: '#f97316',
        borderStyle: 'dashed',
        borderWidth: 2,
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
    badges.push(
      <span
        key="parallel"
        className="px-1.5 py-0.5 text-[10px] font-bold bg-blue-200 dark:bg-blue-900/30 !text-gray-950 dark:!text-white rounded border border-blue-400 dark:border-blue-700"
      >
        ∥ {metadata.parallelMethod}
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
  nodes: typeof workflow.nodes;
  additionalEdges: Array<{
    id: string;
    source: string;
    target: string;
    type: string;
    label?: string;
  }>;
} {
  const nodes = [...workflow.nodes];
  const additionalEdges: Array<{
    id: string;
    source: string;
    target: string;
    type: string;
    label?: string;
  }> = [];

  // Group nodes by their control flow context
  const parallelGroups = new Map<string, typeof workflow.nodes>();
  const loopNodes = new Map<string, typeof workflow.nodes>();
  const conditionalGroups = new Map<
    string,
    { thenBranch: typeof workflow.nodes; elseBranch: typeof workflow.nodes }
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
        borderWidth: 2,
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
          if (!cfgLabel) cfgLabel = '∥';
          break;
        case 'loop':
          baseStrokeColor = '#a855f7';
          strokeDasharray = '5,5';
          // Don't add label for loop-back edges - nodes already have badges
          // Loop-back edges get a different path type for better visualization
          if (edge.source === edge.target || !edge.isOriginal) {
            edgeType = 'step';
            cfgLabel = undefined; // No label on back edges
          }
          break;
        case 'conditional':
          baseStrokeColor = '#f59e0b';
          strokeDasharray = '8,4';
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
        width: 20,
        height: 20,
        color: finalStrokeColor,
      },
      style: {
        strokeWidth: isTraversed ? 3 : 2,
        stroke: finalStrokeColor,
        opacity: execution && !isTraversed ? 0.3 : 1,
        strokeDasharray: finalDasharray,
      },
    };
  });
}

export function WorkflowGraphExecutionViewer({
  workflow,
  execution,
  onNodeClick,
}: WorkflowGraphExecutionViewerProps) {
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
  useEffect(() => {
    setNodes(convertToReactFlowNodes(workflow, execution));
    setEdges(convertToReactFlowEdges(workflow, execution));
  }, [workflow, execution, setNodes, setEdges]);

  const handleNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      if (onNodeClick && node.data.executions) {
        onNodeClick(node.id, node.data.executions as StepExecution[]);
      }
    },
    [onNodeClick]
  );

  return (
    <div className="h-full w-full border rounded-none bg-background relative">
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

        {/* Legend with execution states */}
        <Panel
          position="top-left"
          className="bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 border rounded-lg p-2 text-xs"
        >
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-green-100 dark:bg-green-950 border-2 border-green-600" />
              <span>Completed</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-amber-100 dark:bg-amber-950 border-2 border-amber-600" />
              <span>Running</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-red-100 dark:bg-red-950 border-2 border-red-600" />
              <span>Failed</span>
            </div>
            <div className="flex items-center gap-2">
              <div
                className="w-3 h-3 rounded-full bg-orange-100 dark:bg-orange-950 border-2 border-orange-600"
                style={{ borderStyle: 'dashed' }}
              />
              <span>Retrying</span>
            </div>
            <div className="flex items-center gap-2 opacity-50">
              <div className="w-3 h-3 rounded-full bg-gray-100 dark:bg-gray-800 border-2 border-gray-400" />
              <span>Not Executed</span>
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
  );
}
