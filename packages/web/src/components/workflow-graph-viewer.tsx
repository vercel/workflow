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
import { useEffect, useMemo } from 'react';
import '@xyflow/react/dist/style.css';
import { GitBranch, PlayCircle, StopCircle } from 'lucide-react';
import './workflow-graph-viewer.css';
import type { GraphNode, WorkflowGraph } from '@/lib/workflow-graph-types';

interface WorkflowGraphViewerProps {
  workflow: WorkflowGraph;
}

// Custom node components
const nodeTypes = {};

// Get node styling based on node kind - uses theme-aware colors
function getNodeStyle(nodeKind: string) {
  const baseStyle = {
    color: 'hsl(var(--card-foreground))',
  };

  if (nodeKind === 'workflow_start') {
    return {
      ...baseStyle,
      backgroundColor: 'rgba(34, 197, 94, 0.15)', // green with 15% opacity
      borderColor: '#22c55e', // green-500 - works in both light and dark
    };
  }
  if (nodeKind === 'workflow_end') {
    return {
      ...baseStyle,
      backgroundColor: 'rgba(148, 163, 184, 0.15)', // slate with 15% opacity
      borderColor: '#94a3b8', // slate-400 - works in both light and dark
    };
  }
  return {
    ...baseStyle,
    backgroundColor: 'rgba(96, 165, 250, 0.15)', // blue with 15% opacity
    borderColor: '#60a5fa', // blue-400 - works in both light and dark
  };
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

// Convert our graph nodes to React Flow format
function convertToReactFlowNodes(workflow: WorkflowGraph): Node[] {
  const { nodes } = calculateEnhancedLayout(workflow);

  return nodes.map((node) => {
    const styles = getNodeStyle(node.data.nodeKind);

    // Determine node type based on its role in the workflow
    let nodeType: 'input' | 'output' | 'default' = 'default';
    if (node.type === 'workflowStart') {
      nodeType = 'input'; // Only source handle (outputs edges)
    } else if (node.type === 'workflowEnd') {
      nodeType = 'output'; // Only target handle (receives edges)
    }

    // Add CFG metadata badges
    const metadata = node.metadata;
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

    return {
      id: node.id,
      type: nodeType,
      position: node.position,
      data: {
        ...node.data,
        label: (
          <div className="flex flex-col gap-1.5 w-full overflow-hidden">
            <div className="flex items-start gap-2 w-full overflow-hidden">
              <div className="flex-shrink-0">
                {getNodeIcon(node.data.nodeKind)}
              </div>
              <span className="text-sm font-medium break-words whitespace-normal leading-tight flex-1 min-w-0">
                {node.data.label}
              </span>
            </div>
            {badges.length > 0 && (
              <div className="flex flex-wrap gap-1">{badges}</div>
            )}
          </div>
        ),
      },
      style: {
        borderWidth: 1,
        borderRadius: 8,
        padding: 12,
        width: 220,
        ...styles,
      },
    };
  });
}

// Convert our graph edges to React Flow format
function convertToReactFlowEdges(workflow: WorkflowGraph): Edge[] {
  const { additionalEdges } = calculateEnhancedLayout(workflow);

  // Combine original edges with additional loop-back edges
  const allEdges = [
    ...workflow.edges.map((e) => ({ ...e, isOriginal: true })),
    ...additionalEdges.map((e) => ({ ...e, isOriginal: false })),
  ];

  return allEdges.map((edge) => {
    // Customize edge style based on type
    let strokeColor = '#94a3b8'; // default gray
    let strokeWidth = 1;
    let strokeDasharray: string | undefined;
    const animated = false;
    let label: string | undefined = edge.label;
    let edgeType: 'smoothstep' | 'straight' | 'step' = 'smoothstep';

    switch (edge.type) {
      case 'parallel':
        strokeColor = '#3b82f6'; // blue
        strokeWidth = 1.5;
        strokeDasharray = '4,4';
        // No label needed - nodes have Promise.all/race/allSettled badges
        label = undefined;
        break;
      case 'loop':
        strokeColor = '#a855f7'; // purple
        strokeWidth = 1.5;
        strokeDasharray = '5,5';
        // Loop-back edges get a different path type for better visualization
        if (edge.source === edge.target || !edge.isOriginal) {
          edgeType = 'step';
        }
        // No label needed - nodes have loop badges
        label = undefined;
        break;
      case 'conditional':
        strokeColor = '#f59e0b'; // amber
        strokeWidth = 1;
        strokeDasharray = '8,4';
        // No label needed - nodes have if/else badges
        label = undefined;
        break;
      default:
        // Keep default styling
        break;
    }

    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: edgeType,
      animated,
      label,
      labelStyle: { fontSize: 12, fontWeight: 600 },
      labelBgPadding: [4, 2] as [number, number],
      labelBgBorderRadius: 4,
      labelBgStyle: { fill: strokeColor, fillOpacity: 0.15 },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        width: 12,
        height: 12,
        color: strokeColor,
      },
      style: {
        strokeWidth,
        stroke: strokeColor,
        strokeDasharray,
      },
    };
  });
}

export function WorkflowGraphViewer({ workflow }: WorkflowGraphViewerProps) {
  const initialNodes = useMemo(
    () => convertToReactFlowNodes(workflow),
    [workflow]
  );
  const initialEdges = useMemo(
    () => convertToReactFlowEdges(workflow),
    [workflow]
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  // Update nodes and edges when workflow changes
  useEffect(() => {
    setNodes(convertToReactFlowNodes(workflow));
    setEdges(convertToReactFlowEdges(workflow));
  }, [workflow, setNodes, setEdges]);

  return (
    <div className="h-full w-full border rounded-lg bg-background relative overflow-hidden">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        fitView
        minZoom={0.1}
        maxZoom={2}
        defaultViewport={{ x: 0, y: 0, zoom: 1 }}
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <Controls />
        <Panel
          position="top-left"
          className="bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 border rounded-lg p-3 text-xs"
        >
          <div className="space-y-3">
            {/* Node types */}
            <div className="space-y-1">
              <div className="font-semibold text-[10px] text-muted-foreground mb-1.5">
                Node Types
              </div>
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-green-100 dark:bg-green-950 border-2 border-green-600 dark:border-green-400" />
                <span>Workflow Start</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-blue-100 dark:bg-blue-950 border-2 border-blue-600 dark:border-blue-400" />
                <span>Step</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-gray-100 dark:bg-gray-800 border-2 border-gray-600 dark:border-gray-400" />
                <span>Workflow End</span>
              </div>
            </div>

            {/* Control flow */}
            <div className="space-y-1 pt-2 border-t">
              <div className="font-semibold text-[10px] text-muted-foreground mb-1.5">
                Control Flow
              </div>
              <div className="flex items-center gap-2">
                <div
                  className="w-12 h-0.5 bg-blue-500"
                  style={{ boxShadow: '0 0 4px rgba(59, 130, 246, 0.5)' }}
                />
                <span>∥ Parallel</span>
              </div>
              <div className="flex items-center gap-2">
                <div
                  className="w-12 h-0.5 bg-purple-500"
                  style={{
                    backgroundImage:
                      'repeating-linear-gradient(90deg, #a855f7, #a855f7 5px, transparent 5px, transparent 10px)',
                  }}
                />
                <span>⟳ Loop</span>
              </div>
              <div className="flex items-center gap-2">
                <div
                  className="w-12 h-0.5 bg-amber-500"
                  style={{
                    backgroundImage:
                      'repeating-linear-gradient(90deg, #f59e0b, #f59e0b 8px, transparent 8px, transparent 12px)',
                  }}
                />
                <span>Conditional</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-12 h-0.5 bg-gray-400" />
                <span>Sequential</span>
              </div>
            </div>
          </div>
        </Panel>
      </ReactFlow>
    </div>
  );
}
