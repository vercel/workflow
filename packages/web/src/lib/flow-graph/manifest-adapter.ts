/**
 * Adapter to convert the new manifest format to the format expected by UI components
 * The new manifest has a nested structure and doesn't include node positions,
 * so this adapter transforms the data and calculates layout positions.
 */

import type {
  GraphEdge,
  GraphNode,
  LegacyManifestWorkflowEntry,
  LegacyWorkflowsManifest,
  NewManifestWorkflowEntry,
  NewWorkflowsManifest,
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
  NODE_HEIGHT: 100,
  HORIZONTAL_SPACING: 280,
  VERTICAL_SPACING: 320,
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
          | 'step'
          | 'primitive'
          | 'agent'
          | 'tool',
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
          | 'step'
          | 'primitive'
          | 'agent'
          | 'tool',
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
 * Detects whether a manifest is in the new ID-keyed format (1.0.0+)
 * or the legacy file-path-keyed format.
 *
 * New format has workflow entries with `name` and `exports` fields.
 * Legacy format has nested structure: { [filePath]: { [workflowName]: { workflowId, graph } } }
 */
function isNewManifestFormat(
  raw: RawWorkflowsManifest
): raw is NewWorkflowsManifest {
  if (!raw?.workflows) return false;

  // Check the first workflow entry to determine format
  const firstEntry = Object.values(raw.workflows)[0];
  if (!firstEntry) return false;

  // New format: entries have `name` and `exports` fields directly
  // Legacy format: entries are nested objects keyed by workflow name
  return (
    typeof firstEntry === 'object' &&
    'name' in firstEntry &&
    'exports' in firstEntry
  );
}

/**
 * Adapts a legacy format manifest (file-path keyed) to the UI format
 *
 * Legacy format:
 * {
 *   version?: string,
 *   workflows: { [filePath]: { [workflowName]: { workflowId, graph: { nodes, edges } } } }
 * }
 */
function adaptLegacyManifest(
  raw: LegacyWorkflowsManifest
): WorkflowGraphManifest {
  const workflows: Record<string, WorkflowGraph> = {};

  if (!raw?.workflows) {
    return { version: raw?.version || '1.0.0', workflows: {} };
  }

  for (const [filePath, workflowsInFile] of Object.entries(raw.workflows)) {
    for (const [workflowName, entry] of Object.entries(workflowsInFile)) {
      const typedEntry = entry as LegacyManifestWorkflowEntry;
      // Calculate positions for nodes since they're not provided
      const positionedNodes = calculateNodePositions(
        typedEntry.graph.nodes,
        typedEntry.graph.edges
      );

      const workflowGraph: WorkflowGraph = {
        workflowId: typedEntry.workflowId,
        workflowName: workflowName,
        filePath: filePath,
        nodes: positionedNodes,
        edges: typedEntry.graph.edges,
      };

      // Use workflowId as the key for lookup
      workflows[typedEntry.workflowId] = workflowGraph;
    }
  }

  return {
    version: raw.version || '1.0.0',
    workflows,
  };
}

/**
 * Adapts a new format manifest (ID-keyed) to the UI format
 *
 * New format (1.0.0+):
 * {
 *   version: "1.0.0",
 *   workflows: { [workflowId]: { workflowId, name, exports: { workflow?: string, default?: string }, graph?: { nodes, edges } } }
 * }
 */
function adaptNewManifest(raw: NewWorkflowsManifest): WorkflowGraphManifest {
  const workflows: Record<string, WorkflowGraph> = {};

  if (!raw?.workflows) {
    return { version: raw?.version || '1.0.0', workflows: {} };
  }

  for (const [workflowId, entry] of Object.entries(raw.workflows)) {
    const typedEntry = entry as NewManifestWorkflowEntry;

    // Get file path from exports (prefer workflow condition, fall back to default)
    const filePath =
      typedEntry.exports?.workflow || typedEntry.exports?.default || 'unknown';

    // Skip if no graph data
    if (!typedEntry.graph) {
      continue;
    }

    // Calculate positions for nodes since they're not provided
    const positionedNodes = calculateNodePositions(
      typedEntry.graph.nodes,
      typedEntry.graph.edges
    );

    const workflowGraph: WorkflowGraph = {
      workflowId: workflowId,
      workflowName: typedEntry.name,
      filePath: filePath,
      nodes: positionedNodes,
      edges: typedEntry.graph.edges,
    };

    // Use workflowId as the key for lookup
    workflows[workflowId] = workflowGraph;
  }

  return {
    version: raw.version,
    workflows,
  };
}

/**
 * Converts a raw manifest to the format expected by UI components.
 * Supports both legacy (file-path keyed) and new (ID-keyed) formats.
 *
 * Expected output format:
 * {
 *   version: "1.0.0",
 *   workflows: { [workflowId]: { workflowId, workflowName, filePath, nodes, edges } }
 * }
 */
export function adaptManifest(
  raw: RawWorkflowsManifest
): WorkflowGraphManifest {
  console.log('[adaptManifest] Raw manifest version:', raw?.version);
  console.log(
    '[adaptManifest] Raw workflows keys:',
    Object.keys(raw?.workflows || {})
  );

  if (!raw?.workflows) {
    console.log('[adaptManifest] No workflows in manifest, returning empty');
    return { version: raw?.version || '1.0.0', workflows: {} };
  }

  // Detect format and adapt accordingly
  const isNewFormat = isNewManifestFormat(raw);
  console.log(
    '[adaptManifest] Detected format:',
    isNewFormat ? 'new (ID-keyed)' : 'legacy (file-path keyed)'
  );

  const result = isNewFormat
    ? adaptNewManifest(raw as NewWorkflowsManifest)
    : adaptLegacyManifest(raw as LegacyWorkflowsManifest);

  console.log(
    '[adaptManifest] Adapted workflows count:',
    Object.keys(result.workflows).length
  );

  return result;
}
