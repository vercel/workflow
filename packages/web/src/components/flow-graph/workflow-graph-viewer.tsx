'use client';

import {
  Background,
  BaseEdge,
  Controls,
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
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
import { useEffect, useMemo } from 'react';
import '@xyflow/react/dist/style.css';
import { Clock, Link2, PlayCircle, StopCircle, Zap } from 'lucide-react';
import './workflow-graph-viewer.css';
import type {
  GraphNode,
  WorkflowGraph,
} from '@/lib/flow-graph/workflow-graph-types';

// ============================================================================
// SHARED TYPES
// ============================================================================

export interface NodeStyleResult {
  color: string;
  backgroundColor: string;
  borderColor: string;
  borderWidth?: number;
  opacity?: number;
}

export interface LoopNodeData {
  label: React.ReactNode;
  nodeKind: string;
  isLoopNode?: boolean;
  isAwaitLoop?: boolean;
  nodeStyle?: React.CSSProperties;
  className?: string;
  [key: string]: unknown;
}

export interface DiamondNodeData {
  label: React.ReactNode;
  nodeKind: string;
  nodeStyle?: React.CSSProperties;
  className?: string;
  [key: string]: unknown;
}

export interface ParallelGroupData {
  label: string;
  groupWidth?: number;
  groupHeight?: number;
  [key: string]: unknown;
}

// Edge type with optional consolidation flag
export type ConsolidatedEdge = {
  id: string;
  source: string;
  target: string;
  type?: string;
  label?: string;
  sourceHandle?: string;
  targetHandle?: string;
  isConsolidated?: boolean;
  isOriginal?: boolean;
  originalEdgeIds?: string[]; // Track original edge IDs when consolidated
};

// ============================================================================
// SHARED CONSTANTS
// ============================================================================

// Layout constants
export const LAYOUT = {
  NODE_WIDTH: 220,
  NODE_HEIGHT: 120,
  HORIZONTAL_SPACING: 280,
  VERTICAL_SPACING: 220,
  START_X: 250,
  PARALLEL_GROUP_PADDING: 25,
};

interface WorkflowGraphViewerProps {
  workflow: WorkflowGraph;
}

// ============================================================================
// SHARED COMPONENTS
// ============================================================================

// Custom Loop Node component with left-side handles for self-loop edge
export function LoopNodeComponent({ data, selected }: NodeProps) {
  const nodeData = data as LoopNodeData;

  return (
    <div
      className={`relative ${nodeData.className || ''}`}
      style={{
        borderWidth: nodeData.nodeStyle?.borderWidth ?? 1,
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

// Custom parallel group component with label
export function ParallelGroupComponent({ data }: { data: ParallelGroupData }) {
  return (
    <div
      style={{
        width: data.groupWidth || 200,
        height: data.groupHeight || 100,
        position: 'relative',
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 8,
          left: 12,
          fontSize: 11,
          fontWeight: 600,
          color: 'rgba(59, 130, 246, 0.8)',
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
          pointerEvents: 'none',
        }}
      >
        {data.label}
      </span>
    </div>
  );
}

// Custom Diamond Node component for conditional nodes
export function DiamondNodeComponent({ data, selected }: NodeProps) {
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

// Custom node components - base types for static graph viewing
export const baseNodeTypes = {
  loopNode: LoopNodeComponent,
  parallelGroup: ParallelGroupComponent,
  diamondNode: DiamondNodeComponent,
};

// Node types for this viewer (same as base)
const nodeTypes = baseNodeTypes;

// Self-loop edge styling options
export interface SelfLoopEdgeStyle {
  strokeColor?: string;
  labelBgClass?: string;
}

// Default self-loop edge style (gray for static view)
export const defaultSelfLoopStyle: SelfLoopEdgeStyle = {
  strokeColor: '#6b7280', // gray-500
  labelBgClass:
    'bg-gray-200 dark:bg-gray-700 text-black dark:text-gray-200 border-gray-400 dark:border-gray-500',
};

// Execution self-loop edge style (purple for execution view)
export const executionSelfLoopStyle: SelfLoopEdgeStyle = {
  strokeColor: '#a855f7', // purple-500
  labelBgClass:
    'bg-purple-200 dark:bg-purple-900/50 text-black dark:text-purple-200 border-purple-400 dark:border-purple-600',
};

// Factory to create a self-loop edge component with custom styling
export function createSelfLoopEdge(
  style: SelfLoopEdgeStyle = defaultSelfLoopStyle
) {
  return function SelfLoopEdge({
    id,
    sourceX,
    sourceY,
    targetX,
    targetY,
    label,
    markerEnd,
  }: EdgeProps) {
    // Calculate the loop path that goes to the left of the node
    const loopOffset = 50; // How far left the loop extends
    const verticalGap = targetY - sourceY;

    // Create a path that exits left, curves around, and enters left
    const path = `
      M ${sourceX} ${sourceY}
      C ${sourceX - loopOffset} ${sourceY},
        ${sourceX - loopOffset} ${targetY},
        ${targetX} ${targetY}
    `;

    // Label position - to the left of the loop edge, slightly up and right
    const labelX = sourceX - loopOffset + 5;
    const labelY = sourceY + verticalGap / 2 - 12;

    return (
      <>
        <BaseEdge
          id={id}
          path={path}
          markerEnd={markerEnd}
          style={{
            stroke: style.strokeColor,
            strokeWidth: 2,
          }}
        />
        {label && (
          <EdgeLabelRenderer>
            <div
              style={{
                position: 'absolute',
                transform: `translate(-100%, -50%) translate(${labelX}px, ${labelY}px)`,
                pointerEvents: 'all',
              }}
              className="nodrag nopan"
            >
              <span
                className={`px-1.5 py-0.5 text-[9px] font-bold rounded border whitespace-nowrap ${style.labelBgClass}`}
              >
                {label}
              </span>
            </div>
          </EdgeLabelRenderer>
        )}
      </>
    );
  };
}

// Default self-loop edge for static graph viewing
const SelfLoopEdge = createSelfLoopEdge(defaultSelfLoopStyle);

// Custom edge types
const edgeTypes = {
  selfLoop: SelfLoopEdge,
};

// Factory to create edge types with custom self-loop styling
export function createEdgeTypes(
  selfLoopStyle: SelfLoopEdgeStyle = defaultSelfLoopStyle
) {
  return {
    selfLoop: createSelfLoopEdge(selfLoopStyle),
  };
}

// ============================================================================
// SHARED UTILITIES
// ============================================================================

// Get base node background color based on node kind
export function getNodeBackgroundColor(nodeKind: string): string {
  if (nodeKind === 'workflow_start' || nodeKind === 'workflow_end') {
    return 'var(--node-bg-start)'; // blue
  }
  if (nodeKind === 'primitive') {
    return 'var(--node-bg-primitive)'; // orange
  }
  if (nodeKind === 'agent') {
    return 'var(--node-bg-agent)'; // pink
  }
  if (nodeKind === 'tool') {
    return 'var(--node-bg-tool)'; // purple
  }
  if (nodeKind === 'conditional') {
    return 'var(--node-bg-conditional)'; // red
  }
  // Default for steps - green
  return 'var(--node-bg-step)';
}

// Get default border color for a node kind
export function getNodeBorderColor(nodeKind: string): string {
  if (nodeKind === 'workflow_start' || nodeKind === 'workflow_end') {
    return '#60a5fa'; // blue-400
  }
  if (nodeKind === 'primitive') {
    return '#f97316'; // orange-500
  }
  if (nodeKind === 'agent') {
    return '#ec4899'; // pink-500
  }
  if (nodeKind === 'tool') {
    return '#a855f7'; // purple-500
  }
  if (nodeKind === 'conditional') {
    return '#ef4444'; // red-500
  }
  // Default for steps - green
  return '#22c55e'; // green-500
}

// Get node styling based on node kind - theme-aware colors using CSS variables
export function getNodeStyle(nodeKind: string): NodeStyleResult {
  return {
    color: 'hsl(var(--card-foreground))',
    backgroundColor: getNodeBackgroundColor(nodeKind),
    borderColor: getNodeBorderColor(nodeKind),
  };
}

// Get node icon based on node kind
export function getNodeIcon(nodeKind: string, label?: string) {
  if (nodeKind === 'workflow_start') {
    return (
      <PlayCircle className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />
    );
  }
  if (nodeKind === 'workflow_end') {
    return (
      <StopCircle className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />
    );
  }
  if (nodeKind === 'primitive') {
    if (label === 'sleep') {
      return (
        <Clock className="h-3.5 w-3.5 text-orange-600 dark:text-orange-400" />
      );
    }
    if (label === 'createHook' || label === 'createWebhook') {
      return (
        <Link2 className="h-3.5 w-3.5 text-orange-600 dark:text-orange-400" />
      );
    }
    return (
      <Clock className="h-3.5 w-3.5 text-orange-600 dark:text-orange-400" />
    );
  }
  if (nodeKind === 'agent') {
    return (
      <span className="h-3.5 w-3.5 text-pink-600 dark:text-pink-400 text-xs">
        🤖
      </span>
    );
  }
  if (nodeKind === 'tool') {
    return (
      <span className="h-3.5 w-3.5 text-purple-600 dark:text-purple-400 text-xs">
        🔧
      </span>
    );
  }
  if (nodeKind === 'conditional') {
    return (
      <span className="h-3.5 w-3.5 text-red-600 dark:text-red-400 text-xs">
        ◇
      </span>
    );
  }
  // Default for steps - use Zap icon
  return <Zap className="h-3.5 w-3.5 text-green-600 dark:text-green-400" />;
}

// Layout result type
export interface EnhancedLayoutResult {
  nodes: GraphNode[];
  groupNodes: Array<{
    id: string;
    type: 'group';
    position: { x: number; y: number };
    style: React.CSSProperties;
    data: ParallelGroupData;
  }>;
  additionalEdges: Array<{
    id: string;
    source: string;
    target: string;
    type: string;
    label?: string;
    sourceHandle?: string;
    targetHandle?: string;
  }>;
}

// Helper to calculate enhanced layout with control flow
export function calculateEnhancedLayout(
  workflow: WorkflowGraph,
  layoutConfig: typeof LAYOUT = LAYOUT
): EnhancedLayoutResult {
  // Clone nodes (positions are always provided by the manifest adapter)
  const nodes: GraphNode[] = workflow.nodes.map((node) => ({ ...node }));
  const groupNodes: EnhancedLayoutResult['groupNodes'] = [];
  const additionalEdges: EnhancedLayoutResult['additionalEdges'] = [];

  // Group nodes by their control flow context
  const parallelGroups = new Map<
    string,
    { nodes: GraphNode[]; method?: string }
  >();
  const loopNodes = new Map<string, GraphNode[]>();
  const conditionalGroups = new Map<
    string,
    { thenBranch: GraphNode[]; elseBranch: GraphNode[] }
  >();

  for (const node of nodes) {
    if (node.metadata?.parallelGroupId) {
      const group = parallelGroups.get(node.metadata.parallelGroupId) || {
        nodes: [],
        method: node.metadata.parallelMethod,
      };
      group.nodes.push(node);
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

  // Layout parallel nodes side-by-side and create visual group containers
  for (const [groupId, group] of parallelGroups) {
    const groupNodes_ = group.nodes;
    if (groupNodes_.length === 0) continue;

    const baseY = groupNodes_[0].position.y;

    // For multiple nodes, spread them horizontally
    if (groupNodes_.length > 1) {
      const spacing = layoutConfig.HORIZONTAL_SPACING;
      const totalWidth = (groupNodes_.length - 1) * spacing;
      const startX = layoutConfig.START_X - totalWidth / 2;

      groupNodes_.forEach((node, idx) => {
        node.position = {
          x: startX + idx * spacing,
          y: baseY,
        };
      });
    }

    // Create a visual group container (even for single nodes to show parallel pattern)
    const minX = Math.min(...groupNodes_.map((n) => n.position.x));
    const maxX = Math.max(...groupNodes_.map((n) => n.position.x));
    const methodLabel =
      group.method === 'all'
        ? 'Promise.all'
        : group.method === 'race'
          ? 'Promise.race'
          : group.method === 'allSettled'
            ? 'Promise.allSettled'
            : group.method === 'any'
              ? 'Promise.any'
              : 'Parallel';

    const groupWidth =
      maxX -
      minX +
      layoutConfig.NODE_WIDTH +
      layoutConfig.PARALLEL_GROUP_PADDING * 2;
    const groupHeight =
      layoutConfig.NODE_HEIGHT + layoutConfig.PARALLEL_GROUP_PADDING * 2;

    groupNodes.push({
      id: `group_${groupId}`,
      type: 'group',
      position: {
        x: minX - layoutConfig.PARALLEL_GROUP_PADDING,
        y: baseY - layoutConfig.PARALLEL_GROUP_PADDING,
      },
      style: {
        width: groupWidth,
        height: groupHeight,
        backgroundColor: 'rgba(59, 130, 246, 0.05)',
        border: '2px dashed rgba(59, 130, 246, 0.3)',
        borderRadius: 12,
      },
      data: { label: methodLabel, groupWidth, groupHeight },
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

  // Create self-loop edges for loop nodes (no container, just the edge with label)
  for (const [, loopNodeList] of loopNodes) {
    if (loopNodeList.length > 0) {
      const isAwaitLoop = loopNodeList.some((n) => n.metadata?.loopIsAwait);

      // Add self-loop edges for each node in the loop (with label on the edge)
      for (const loopNode of loopNodeList) {
        additionalEdges.push({
          id: `self_loop_${loopNode.id}`,
          source: loopNode.id,
          target: loopNode.id,
          sourceHandle: 'loop-out',
          targetHandle: 'loop-in',
          type: 'selfLoop',
          label: isAwaitLoop ? 'await' : 'loop',
        });
      }
    }
  }

  return { nodes, groupNodes, additionalEdges };
}

// Consolidate edges between parallel groups to reduce visual clutter
export function consolidateEdges(
  edges: ConsolidatedEdge[],
  nodes: GraphNode[]
): ConsolidatedEdge[] {
  // Build a map of node -> parallel group
  const nodeToGroup = new Map<string, string>();
  for (const node of nodes) {
    if (node.metadata?.parallelGroupId) {
      nodeToGroup.set(node.id, node.metadata.parallelGroupId);
    }
  }

  // Find edges that connect different parallel groups (N×M pattern)
  // Group edges by source-group → target-group
  const groupToGroupEdges = new Map<string, ConsolidatedEdge[]>();
  const otherEdges: ConsolidatedEdge[] = [];

  for (const edge of edges) {
    const sourceGroup = nodeToGroup.get(edge.source);
    const targetGroup = nodeToGroup.get(edge.target);

    // Only consolidate if both nodes are in different parallel groups
    if (sourceGroup && targetGroup && sourceGroup !== targetGroup) {
      const key = `${sourceGroup}->${targetGroup}`;
      const existing = groupToGroupEdges.get(key) || [];
      existing.push(edge);
      groupToGroupEdges.set(key, existing);
    } else {
      otherEdges.push(edge);
    }
  }

  // For each group-to-group connection, consolidate N×M edges to 1×M
  const consolidatedEdges: ConsolidatedEdge[] = [...otherEdges];

  for (const [, groupEdges] of groupToGroupEdges) {
    if (groupEdges.length > 1) {
      // Find unique targets
      const uniqueTargets = [...new Set(groupEdges.map((e) => e.target))];
      // Pick the first source as the representative
      const representativeSource = groupEdges[0].source;

      // Create one edge from representative source to each unique target
      for (const target of uniqueTargets) {
        const originalEdge = groupEdges.find((e) => e.target === target);
        // Collect all original edge IDs that are being consolidated to this target
        const originalEdgeIds = groupEdges
          .filter((e) => e.target === target)
          .map((e) => e.id);
        consolidatedEdges.push({
          ...originalEdge!,
          id: `consolidated_${representativeSource}_${target}`,
          source: representativeSource,
          target,
          isConsolidated: true,
          originalEdgeIds,
        });
      }
    } else {
      // Only one edge, keep as-is
      consolidatedEdges.push(...groupEdges);
    }
  }

  return consolidatedEdges;
}

// Convert our graph nodes to React Flow format
function convertToReactFlowNodes(workflow: WorkflowGraph): Node[] {
  const { nodes, groupNodes } = calculateEnhancedLayout(workflow);

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
      draggable: true,
      selectable: true,
    });
  }

  // Add regular nodes
  nodes.forEach((node) => {
    const styles = getNodeStyle(node.data.nodeKind);
    const metadata = node.metadata;
    const isLoopNode = !!metadata?.loopId;
    const isAwaitLoop = !!metadata?.loopIsAwait;
    const isConditionalNode = node.data.nodeKind === 'conditional';

    // Determine node type - use custom node types for loops and conditionals
    let nodeType: 'input' | 'output' | 'default' | 'loopNode' | 'diamondNode' =
      isConditionalNode ? 'diamondNode' : isLoopNode ? 'loopNode' : 'default';
    if (node.type === 'workflowStart') {
      nodeType = 'input'; // Only source handle (outputs edges)
    } else if (node.type === 'workflowEnd') {
      nodeType = 'output'; // Only target handle (receives edges)
    }

    // Add CFG metadata badges (conditionalBranch badges removed - now using conditional nodes with edge labels)
    const badges: React.ReactNode[] = [];

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

    const nodeLabel = (
      <div
        key={`label-${node.id}`}
        className="flex flex-col gap-1.5 w-full overflow-hidden"
      >
        <div className="flex items-start gap-2 w-full overflow-hidden">
          <div className="flex-shrink-0">
            {getNodeIcon(node.data.nodeKind, node.data.label)}
          </div>
          <span className="text-sm font-medium break-words whitespace-normal leading-tight flex-1 min-w-0">
            {node.data.label}
          </span>
        </div>
        {badges.length > 0 && (
          <div className="flex flex-wrap gap-1">{badges}</div>
        )}
      </div>
    );

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
          label: nodeLabel,
          isLoopNode: true,
          isAwaitLoop,
          nodeStyle: styles,
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
          nodeStyle: styles,
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
          label: nodeLabel,
        },
        style: {
          borderWidth: 1,
          borderRadius: 8,
          padding: 12,
          width: 220,
          ...styles,
        },
      });
    }
  });

  return reactFlowNodes;
}

// Convert our graph edges to React Flow format
function convertToReactFlowEdges(workflow: WorkflowGraph): Edge[] {
  const { additionalEdges } = calculateEnhancedLayout(workflow);

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
          color: '#6b7280', // gray-500
        },
      };
    }

    // Simple edge styling - neutral color that works in both light/dark modes
    const strokeColor = '#6b7280'; // gray-500 - visible in both modes
    let strokeWidth = 1;
    let strokeDasharray: string | undefined;
    const animated = false;
    let label: string | undefined = edge.label;
    let edgeType: 'smoothstep' | 'straight' | 'step' | 'bezier' = 'bezier';

    // Track if this is a conditional edge for special label styling
    let isConditional = false;

    switch (edge.type) {
      case 'parallel':
        strokeWidth = 1.5;
        strokeDasharray = '4,4';
        edgeType = 'smoothstep';
        label = undefined;
        break;
      case 'loop':
        strokeWidth = 2;
        strokeDasharray = '8,4';
        edgeType = 'step';
        // Keep label for loop-back edges
        break;
      case 'conditional':
        strokeDasharray = '8,4';
        edgeType = 'smoothstep';
        isConditional = true;
        // Keep the edge label (e.g., "true" or "false") for conditional edges
        break;
      default:
        edgeType = 'bezier';
        break;
    }

    // Label styling - conditional edges get dark bg with white text
    const labelTextColor = isConditional ? '#ffffff' : '#6b7280';
    const labelBgColor = isConditional ? '#374151' : '#f3f4f6'; // gray-700 : gray-100
    const labelBorderColor = isConditional ? '#4b5563' : '#d1d5db'; // gray-600 : gray-300

    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: edgeType,
      animated,
      label,
      labelStyle: {
        fill: labelTextColor,
        fontWeight: 500,
        fontSize: '11px',
      },
      labelBgPadding: [4, 6] as [number, number],
      labelBgBorderRadius: 4,
      labelBgStyle: {
        fill: labelBgColor,
        fillOpacity: 0.95,
        stroke: labelBorderColor,
        strokeWidth: 1,
      },
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
        edgeTypes={edgeTypes}
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
                <div className="w-3 h-3 rounded-full bg-blue-500" />
                <span>Start / End</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-green-500" />
                <span>Step</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-orange-500" />
                <span>Primitive (sleep, hook)</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-red-500" />
                <span>Conditional</span>
              </div>
            </div>

            {/* Edge types */}
            <div className="space-y-1 pt-2 border-t">
              <div className="font-semibold text-[10px] text-muted-foreground mb-1.5">
                Edge Types
              </div>
              <div className="flex items-center gap-2">
                <div className="w-8 h-0.5 bg-gray-500" />
                <span>Sequential</span>
              </div>
              <div className="flex items-center gap-2">
                <div
                  className="w-8 h-0.5"
                  style={{
                    backgroundImage:
                      'repeating-linear-gradient(90deg, #6b7280, #6b7280 4px, transparent 4px, transparent 8px)',
                  }}
                />
                <span>Parallel / Loop / Conditional</span>
              </div>
            </div>
          </div>
        </Panel>
      </ReactFlow>
    </div>
  );
}
