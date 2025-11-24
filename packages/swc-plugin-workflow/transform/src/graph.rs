use serde::Serialize;
use std::collections::HashMap;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowGraphManifest {
    pub version: String,
    pub workflows: HashMap<String, WorkflowGraph>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub debug_info: Option<DebugInfo>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugInfo {
    pub manifest_present: bool,
    pub manifest_step_files: usize,
    pub imports_resolved: usize,
    pub imports_with_kind: usize,
    pub import_details: Vec<ImportDebugInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cfg_detection_version: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportDebugInfo {
    pub local_name: String,
    pub source: String,
    pub imported_name: String,
    pub kind: Option<String>,
    pub lookup_candidates: Vec<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowGraph {
    pub workflow_id: String,
    pub workflow_name: String,
    pub file_path: String,
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    pub id: String,
    #[serde(rename = "type")]
    pub node_type: String,
    pub position: Position,
    pub data: NodeData,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<NodeMetadata>,
}

#[derive(Debug, Serialize, Clone)]
pub struct Position {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NodeData {
    pub label: String,
    pub node_kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step_id: Option<String>,
    pub line: usize,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NodeMetadata {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub loop_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub loop_is_await: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conditional_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conditional_branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parallel_group_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parallel_method: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GraphEdge {
    pub id: String,
    pub source: String,
    pub target: String,
    #[serde(rename = "type")]
    pub edge_type: EdgeType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "lowercase")]
pub enum EdgeType {
    Default,
    Loop,
    Conditional,
    Parallel,
}

#[derive(Debug)]
pub struct GraphBuilder {
    graphs: HashMap<String, WorkflowGraph>,
    current_workflow: Option<String>,
    current_y: f64,
    node_count: usize,
    prev_node_id: Option<String>,
}

impl GraphBuilder {
    pub fn new() -> Self {
        Self {
            graphs: HashMap::new(),
            current_workflow: None,
            current_y: 0.0,
            node_count: 0,
            prev_node_id: None,
        }
    }

    pub fn start_workflow(&mut self, name: &str, file_path: &str, workflow_id: &str) {
        let graph = WorkflowGraph {
            workflow_id: workflow_id.to_string(),
            workflow_name: name.to_string(),
            file_path: file_path.to_string(),
            nodes: vec![],
            edges: vec![],
        };

        self.graphs.insert(name.to_string(), graph);
        self.current_workflow = Some(name.to_string());
        self.current_y = 0.0;
        self.node_count = 0;
        self.prev_node_id = None;

        // Add start node
        self.add_node(
            "start",
            "workflowStart",
            &format!("Start: {}", name),
            "workflow_start",
            None,
            0,
            None,
            EdgeType::Default,
        );
    }

    pub fn add_step_node(
        &mut self,
        step_name: &str,
        step_id: &str,
        line: usize,
        metadata: Option<NodeMetadata>,
        edge_type: EdgeType,
    ) {
        let node_id = format!("node_{}", self.node_count);
        self.add_node(
            &node_id,
            "step",
            step_name,
            "step",
            Some(step_id.to_string()),
            line,
            metadata,
            edge_type,
        );
    }

    pub fn add_workflow_node(
        &mut self,
        workflow_name: &str,
        workflow_id: &str,
        line: usize,
        metadata: Option<NodeMetadata>,
        edge_type: EdgeType,
    ) {
        let node_id = format!("node_{}", self.node_count);
        self.add_node(
            &node_id,
            "workflowCall",
            workflow_name,
            "workflow",
            Some(workflow_id.to_string()),
            line,
            metadata,
            edge_type,
        );
    }

    // Smart node addition with proper CFG edge generation
    pub fn add_nodes_with_cfg(
        &mut self,
        nodes: &[(String, String, usize, Option<NodeMetadata>, EdgeType, bool)],
    ) {
        if nodes.is_empty() {
            return;
        }

        let Some(workflow_name) = &self.current_workflow.clone() else {
            return;
        };

        // Group nodes by parallel groups, loops, and conditionals
        use std::collections::HashMap;
        let mut parallel_groups: HashMap<String, Vec<usize>> = HashMap::new();
        let mut loop_groups: HashMap<String, Vec<usize>> = HashMap::new();
        let mut conditional_groups: HashMap<String, Vec<usize>> = HashMap::new();

        // First pass: add all nodes and identify groups
        let start_node_count = self.node_count;
        for (idx, (name, id, line, metadata, _edge_type, is_workflow)) in nodes.iter().enumerate() {
            let node_id = format!("node_{}", self.node_count);

            if *is_workflow {
                self.add_node(
                    &node_id,
                    "workflowCall",
                    name,
                    "workflow",
                    Some(id.to_string()),
                    *line,
                    metadata.clone(),
                    EdgeType::Default, // Will be determined by edges below
                );
            } else {
                self.add_node(
                    &node_id,
                    "step",
                    name,
                    "step",
                    Some(id.to_string()),
                    *line,
                    metadata.clone(),
                    EdgeType::Default, // Will be determined by edges below
                );
            }

            // Track parallel groups, loops, and conditionals using actual node count
            if let Some(meta) = metadata {
                if let Some(parallel_id) = &meta.parallel_group_id {
                    parallel_groups
                        .entry(parallel_id.clone())
                        .or_insert_with(Vec::new)
                        .push(start_node_count + idx);
                }
                if let Some(loop_id) = &meta.loop_id {
                    loop_groups
                        .entry(loop_id.clone())
                        .or_insert_with(Vec::new)
                        .push(start_node_count + idx);
                }
                if let Some(cond_id) = &meta.conditional_id {
                    conditional_groups
                        .entry(cond_id.clone())
                        .or_insert_with(Vec::new)
                        .push(start_node_count + idx);
                }
            }
        }

        // Second pass: create edges based on control flow
        let Some(graph) = self.graphs.get_mut(workflow_name) else {
            return;
        };

        let mut connected_nodes = std::collections::HashSet::new();
        connected_nodes.insert("start".to_string());

        // Connect conditional branches
        for (cond_id, node_nums) in &conditional_groups {
            if node_nums.len() <= 1 {
                continue;
            }

            // Find the source node (last connected node before this conditional)
            let source_node = if node_nums[0] == start_node_count {
                "start".to_string()
            } else {
                format!("node_{}", node_nums[0] - 1)
            };

            // Create branch edges from source to all nodes in conditional
            for &node_num in node_nums.iter() {
                let target_node = format!("node_{}", node_num);
                if !connected_nodes.contains(&target_node) {
                    graph.edges.push(GraphEdge {
                        id: format!("e_{}_{}", source_node, target_node),
                        source: source_node.clone(),
                        target: target_node.clone(),
                        edge_type: EdgeType::Conditional,
                        label: None,
                    });
                    connected_nodes.insert(target_node.clone());
                }
            }

            // Note: Don't create edges here - let sequential logic handle post-conditional connections
        }

        // Connect parallel groups
        for (group_id, node_nums) in &parallel_groups {
            if node_nums.len() <= 1 {
                continue;
            }

            // Find the source node (last connected node before this group)
            let source_node = if node_nums[0] == start_node_count {
                "start".to_string()
            } else {
                format!("node_{}", node_nums[0] - 1)
            };

            // Create fork edges from source to all nodes in parallel group
            for &node_num in node_nums.iter() {
                let target_node = format!("node_{}", node_num);
                if !connected_nodes.contains(&target_node) {
                    graph.edges.push(GraphEdge {
                        id: format!("e_{}_{}", source_node, target_node),
                        source: source_node.clone(),
                        target: target_node.clone(),
                        edge_type: EdgeType::Parallel,
                        label: None,
                    });
                    connected_nodes.insert(target_node.clone());
                }
            }
        }

        // Connect sequential nodes and handle transitions from parallel/conditional groups
        let mut prev_node: Option<String> = Some("start".to_string());

        for (idx, (_name, _id, _line, metadata, _edge_type, _is_workflow)) in
            nodes.iter().enumerate()
        {
            let current_node_num = start_node_count + idx;
            let current_node = format!("node_{}", current_node_num);

            let in_parallel = metadata
                .as_ref()
                .and_then(|m| m.parallel_group_id.as_ref())
                .is_some();
            let in_conditional = metadata
                .as_ref()
                .and_then(|m| m.conditional_id.as_ref())
                .is_some();

            // If already connected via parallel/conditional logic, track last node in group
            if connected_nodes.contains(&current_node) {
                if (in_parallel || in_conditional) && idx + 1 < nodes.len() {
                    let current_group = if in_parallel {
                        metadata.as_ref().and_then(|m| m.parallel_group_id.as_ref())
                    } else {
                        metadata.as_ref().and_then(|m| m.conditional_id.as_ref())
                    };

                    let next_meta = &nodes[idx + 1].3;
                    let next_group = if in_parallel {
                        next_meta
                            .as_ref()
                            .and_then(|m| m.parallel_group_id.as_ref())
                    } else {
                        next_meta.as_ref().and_then(|m| m.conditional_id.as_ref())
                    };

                    if current_group != next_group {
                        prev_node = Some(current_node.clone());
                    }
                } else if !in_parallel && !in_conditional {
                    prev_node = Some(current_node.clone());
                }
                continue;
            }

            // Connect sequential nodes
            if !in_parallel && !in_conditional {
                if let Some(prev) = &prev_node {
                    graph.edges.push(GraphEdge {
                        id: format!("e_{}_{}", prev, current_node),
                        source: prev.clone(),
                        target: current_node.clone(),
                        edge_type: EdgeType::Default,
                        label: None,
                    });
                    connected_nodes.insert(current_node.clone());
                }
                prev_node = Some(current_node);
            }
        }

        // Add loop back-edges
        for (_loop_id, node_nums) in &loop_groups {
            if node_nums.is_empty() {
                continue;
            }
            let first_node = format!("node_{}", node_nums[0]);
            let last_node = format!("node_{}", node_nums[node_nums.len() - 1]);

            // Add back edge from last to first
            // No label - nodes already show loop badges for clarity
            graph.edges.push(GraphEdge {
                id: format!("e_{}_back_{}", last_node, first_node),
                source: last_node.clone(),
                target: first_node.clone(),
                edge_type: EdgeType::Loop,
                label: None,
            });
        }

        // Update prev_node_id for finish_workflow
        if !nodes.is_empty() {
            self.prev_node_id = Some(format!("node_{}", start_node_count + nodes.len() - 1));
        }
    }

    fn add_node(
        &mut self,
        id: &str,
        node_type: &str,
        label: &str,
        node_kind: &str,
        step_id: Option<String>,
        line: usize,
        metadata: Option<NodeMetadata>,
        _edge_type: EdgeType,
    ) {
        if let Some(workflow_name) = &self.current_workflow {
            if let Some(graph) = self.graphs.get_mut(workflow_name) {
                let node = GraphNode {
                    id: id.to_string(),
                    node_type: node_type.to_string(),
                    position: Position {
                        x: 250.0,
                        y: self.current_y,
                    },
                    data: NodeData {
                        label: label.to_string(),
                        node_kind: node_kind.to_string(),
                        step_id,
                        line,
                    },
                    metadata,
                };

                // NOTE: Edges are now created separately in add_nodes_with_cfg
                // to properly handle parallel/loop/conditional structures

                graph.nodes.push(node);
                self.prev_node_id = Some(id.to_string());
                self.current_y += 100.0;
                self.node_count += 1;
            }
        }
    }

    pub fn finish_workflow(&mut self) {
        if let Some(workflow_name) = &self.current_workflow {
            if let Some(graph) = self.graphs.get_mut(workflow_name) {
                // Add end node
                let end_node = GraphNode {
                    id: "end".to_string(),
                    node_type: "workflowEnd".to_string(),
                    position: Position {
                        x: 250.0,
                        y: self.current_y,
                    },
                    data: NodeData {
                        label: "Return".to_string(),
                        node_kind: "workflow_end".to_string(),
                        step_id: None,
                        line: 0,
                    },
                    metadata: None,
                };

                // Add edge from last node to end
                if let Some(prev_id) = &self.prev_node_id {
                    let edge = GraphEdge {
                        id: format!("e_{}_end", prev_id),
                        source: prev_id.clone(),
                        target: "end".to_string(),
                        edge_type: EdgeType::Default,
                        label: None,
                    };
                    graph.edges.push(edge);
                }

                graph.nodes.push(end_node);
            }
        }

        self.current_workflow = None;
        self.prev_node_id = None;
    }

    pub fn to_manifest(self) -> WorkflowGraphManifest {
        WorkflowGraphManifest {
            version: "1.0.0".to_string(),
            workflows: self.graphs,
            debug_info: None,
        }
    }

    pub fn has_workflows(&self) -> bool {
        !self.graphs.is_empty()
    }
}
