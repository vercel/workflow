/**
 * Adapter to convert the new manifest format to the format expected by UI components
 * The new manifest has a nested structure and doesn't include node positions,
 * so this adapter transforms the data and calculates layout positions.
 */

import type {
  GraphEdge,
  GraphNode,
  RawGraphNode,
  RawWorkflowsManifest,
  WorkflowGraph,
  WorkflowGraphManifest,
} from './workflow-graph-types';

/**
 * Layout constants for auto-positioning nodes
 */
const LAYOUT = {
  NODE_WIDTH: 220,
  NODE_HEIGHT: 80,
  HORIZONTAL_SPACING: 300,
  VERTICAL_SPACING: 120,
  START_X: 250,
  START_Y: 50,
};

/**
 * Calculates initial positions for nodes using a topological layout
 * Nodes are arranged vertically by depth, with parallel nodes spread horizontally
 */
function calculateNodePositions(
  rawNodes: RawGraphNode[],
  edges: GraphEdge[]
): GraphNode[] {
  if (rawNodes.length === 0) return [];

  // Build adjacency maps
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();

  for (const edge of edges) {
    const out = outgoing.get(edge.source) || [];
    out.push(edge.target);
    outgoing.set(edge.source, out);

    const inc = incoming.get(edge.target) || [];
    inc.push(edge.source);
    incoming.set(edge.target, inc);
  }

  // Find start node
  const startNode = rawNodes.find((n) => n.data.nodeKind === 'workflow_start');
  if (!startNode) {
    // Fallback: just stack nodes vertically
    return rawNodes.map((node, idx) => ({
      id: node.id,
      type: node.type,
      data: {
        label: node.data.label,
        nodeKind: node.data.nodeKind as
          | 'workflow_start'
          | 'workflow_end'
          | 'step',
        stepId: node.data.stepId,
      },
      metadata: node.metadata,
      position: {
        x: LAYOUT.START_X,
        y: LAYOUT.START_Y + idx * LAYOUT.VERTICAL_SPACING,
      },
    }));
  }

  // BFS to assign layers (y-positions based on depth from start)
  // Skip back-edges (loops) to avoid infinite loops in the algorithm
  const layers = new Map<string, number>();
  const visited = new Set<string>();
  const queue: string[] = [startNode.id];
  layers.set(startNode.id, 0);

  while (queue.length > 0) {
    const nodeId = queue.shift()!;

    // Skip if already fully processed
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);

    const currentLayer = layers.get(nodeId)!;
    const targets = outgoing.get(nodeId) || [];

    for (const target of targets) {
      // Skip self-loops and back-edges to already visited nodes
      if (target === nodeId || visited.has(target)) continue;

      if (!layers.has(target)) {
        layers.set(target, currentLayer + 1);
        queue.push(target);
      } else {
        // Ensure we use the maximum layer for nodes with multiple incoming edges
        // This handles join points after parallel execution
        const existingLayer = layers.get(target)!;
        if (currentLayer + 1 > existingLayer) {
          layers.set(target, currentLayer + 1);
          // Only re-add if not already in queue
          if (!queue.includes(target)) {
            queue.push(target);
          }
        }
      }
    }
  }

  // Handle any nodes not reached by BFS (disconnected nodes)
  let maxLayer = Math.max(...Array.from(layers.values()), 0);
  for (const node of rawNodes) {
    if (!layers.has(node.id)) {
      maxLayer++;
      layers.set(node.id, maxLayer);
    }
  }

  // Group nodes by layer
  const nodesByLayer = new Map<number, RawGraphNode[]>();
  for (const node of rawNodes) {
    const layer = layers.get(node.id) ?? 0;
    const layerNodes = nodesByLayer.get(layer) || [];
    layerNodes.push(node);
    nodesByLayer.set(layer, layerNodes);
  }

  // Assign positions
  const positioned: GraphNode[] = [];
  for (const node of rawNodes) {
    const layer = layers.get(node.id) ?? 0;
    const layerNodes = nodesByLayer.get(layer) || [node];
    const indexInLayer = layerNodes.findIndex((n) => n.id === node.id);
    const layerWidth = layerNodes.length;

    // Center nodes horizontally within their layer
    const totalWidth = (layerWidth - 1) * LAYOUT.HORIZONTAL_SPACING;
    const startX = LAYOUT.START_X - totalWidth / 2;

    positioned.push({
      id: node.id,
      type: node.type,
      data: {
        label: node.data.label,
        nodeKind: node.data.nodeKind as
          | 'workflow_start'
          | 'workflow_end'
          | 'step',
        stepId: node.data.stepId,
      },
      metadata: node.metadata,
      position: {
        x: startX + indexInLayer * LAYOUT.HORIZONTAL_SPACING,
        y: LAYOUT.START_Y + layer * LAYOUT.VERTICAL_SPACING,
      },
    });
  }

  return positioned;
}

/**
 * Converts the new manifest format to the format expected by UI components
 *
 * New format:
 * {
 *   version: "1.0.0",
 *   steps: { [filePath]: { [stepName]: { stepId } } },
 *   workflows: { [filePath]: { [workflowName]: { workflowId, graph: { nodes, edges } } } }
 * }
 *
 * Expected format:
 * {
 *   version: "1.0.0",
 *   workflows: { [workflowId]: { workflowId, workflowName, filePath, nodes, edges } }
 * }
 */
export function adaptManifest(
  raw: RawWorkflowsManifest
): WorkflowGraphManifest {
  const workflows: Record<string, WorkflowGraph> = {};

  console.log('[adaptManifest] Raw manifest version:', raw?.version);
  console.log(
    '[adaptManifest] Raw workflows keys:',
    Object.keys(raw?.workflows || {})
  );

  if (!raw?.workflows) {
    console.log('[adaptManifest] No workflows in manifest, returning empty');
    return { version: raw?.version || '1.0.0', workflows: {} };
  }

  for (const [filePath, workflowsInFile] of Object.entries(raw.workflows)) {
    for (const [workflowName, entry] of Object.entries(workflowsInFile)) {
      // Calculate positions for nodes since they're not provided
      const positionedNodes = calculateNodePositions(
        entry.graph.nodes,
        entry.graph.edges
      );

      const workflowGraph: WorkflowGraph = {
        workflowId: entry.workflowId,
        workflowName: workflowName,
        filePath: filePath,
        nodes: positionedNodes,
        edges: entry.graph.edges,
      };

      // Use workflowId as the key for lookup
      workflows[entry.workflowId] = workflowGraph;
    }
  }

  console.log(
    '[adaptManifest] Adapted workflows count:',
    Object.keys(workflows).length
  );

  return {
    version: raw.version,
    workflows,
  };
}
