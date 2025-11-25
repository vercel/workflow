import { readFile } from 'node:fs/promises';
import type {
  CallExpression,
  Expression,
  FunctionDeclaration,
  Identifier,
  MemberExpression,
  Program,
  Statement,
  VariableDeclaration,
} from '@swc/core';
import { parseSync } from '@swc/core';

/**
 * Graph manifest structure
 */
export interface GraphManifest {
  version: string;
  workflows: Record<string, WorkflowGraph>;
  debugInfo?: DebugInfo;
}

export interface WorkflowGraph {
  workflowId: string;
  workflowName: string;
  filePath: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: {
    label: string;
    nodeKind: string;
    stepId?: string;
    line: number;
  };
  metadata?: NodeMetadata;
}

export interface NodeMetadata {
  loopId?: string;
  loopIsAwait?: boolean;
  conditionalId?: string;
  conditionalBranch?: string;
  parallelGroupId?: string;
  parallelMethod?: string;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: 'default' | 'loop' | 'conditional' | 'parallel';
  label?: string;
}

export interface DebugInfo {
  manifestPresent?: boolean;
  manifestStepFiles?: number;
  importsResolved?: number;
  importsWithKind?: number;
  importDetails?: Array<{
    localName: string;
    source: string;
    importedName: string;
    kind?: string;
    lookupCandidates: string[];
  }>;
  error?: string;
}

/**
 * Extracts workflow graph from a bundled workflow file
 */
export async function extractGraphFromBundle(
  bundlePath: string
): Promise<GraphManifest> {
  const bundleCode = await readFile(bundlePath, 'utf-8');

  try {
    // The workflow bundle wraps the actual code in a template literal:
    // const workflowCode = `...`;
    // We need to parse the bundle AST first to properly extract the unescaped string
    let actualWorkflowCode = bundleCode;

    // First, try to parse the bundle itself to extract workflowCode properly
    const bundleAst = parseSync(bundleCode, {
      syntax: 'ecmascript',
      target: 'es2022',
    });

    // Find the workflowCode variable declaration
    const workflowCodeValue = extractWorkflowCodeFromBundle(bundleAst);
    if (workflowCodeValue) {
      actualWorkflowCode = workflowCodeValue;
    }

    // Now parse the actual workflow code
    const ast = parseSync(actualWorkflowCode, {
      syntax: 'ecmascript',
      target: 'es2022',
    });

    // Extract step declarations
    const stepDeclarations = extractStepDeclarations(actualWorkflowCode);

    // Extract workflows
    const workflows = extractWorkflows(ast, stepDeclarations);

    return {
      version: '1.0.0',
      workflows,
    };
  } catch (error) {
    console.error('Failed to extract graph from bundle:', error);
    // Return empty manifest on parsing errors
    return {
      version: '1.0.0',
      workflows: {},
      debugInfo: {
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/**
 * Extract the workflowCode string value from a parsed bundle AST
 */
function extractWorkflowCodeFromBundle(ast: Program): string | null {
  for (const item of ast.body) {
    if (item.type === 'VariableDeclaration') {
      for (const decl of item.declarations) {
        if (
          decl.id.type === 'Identifier' &&
          decl.id.value === 'workflowCode' &&
          decl.init
        ) {
          // Handle template literal
          if (decl.init.type === 'TemplateLiteral') {
            // Concatenate all quasis (the string parts of template literal)
            return decl.init.quasis.map((q) => q.cooked || q.raw).join('');
          }
          // Handle regular string literal
          if (decl.init.type === 'StringLiteral') {
            return decl.init.value;
          }
        }
      }
    }
  }
  return null;
}

/**
 * Extract step declarations using regex for speed
 */
function extractStepDeclarations(
  bundleCode: string
): Map<string, { stepId: string; line: number }> {
  const stepDeclarations = new Map<string, { stepId: string; line: number }>();

  // Match: var stepName = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//path//name");
  const stepPattern =
    /var (\w+) = globalThis\[Symbol\.for\("WORKFLOW_USE_STEP"\)\]\("([^"]+)"\)/g;

  // Track line numbers
  const lines = bundleCode.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    stepPattern.lastIndex = 0;
    const match = stepPattern.exec(line);
    if (match) {
      const [, varName, stepId] = match;
      stepDeclarations.set(varName, {
        stepId,
        line: i + 1,
      });
    }
  }

  return stepDeclarations;
}

/**
 * Extract workflows from AST
 */
function extractWorkflows(
  ast: Program,
  stepDeclarations: Map<string, { stepId: string; line: number }>
): Record<string, WorkflowGraph> {
  const workflows: Record<string, WorkflowGraph> = {};

  // Find all function declarations
  for (const item of ast.body) {
    if (item.type === 'FunctionDeclaration') {
      const func = item as FunctionDeclaration;
      if (!func.identifier) continue;

      const workflowName = func.identifier.value;

      // Check if this function has a workflowId property assignment
      // Look for: functionName.workflowId = "workflow//path//name";
      const workflowId = findWorkflowId(ast, workflowName);
      if (!workflowId) continue;

      // Extract file path from workflowId
      // Format: "workflow//path/to/file.ts//functionName"
      const parts = workflowId.split('//');
      const filePath = parts.length > 1 ? parts[1] : '';

      // Analyze the function body
      const graph = analyzeWorkflowFunction(
        func,
        workflowName,
        workflowId,
        filePath,
        stepDeclarations
      );

      workflows[workflowName] = graph;
    }
  }

  return workflows;
}

/**
 * Find workflowId assignment for a function
 */
function findWorkflowId(ast: Program, functionName: string): string | null {
  for (const item of ast.body) {
    if (item.type === 'ExpressionStatement') {
      const expr = item.expression;
      if (expr.type === 'AssignmentExpression') {
        const left = expr.left;
        if (left.type === 'MemberExpression') {
          const obj = left.object;
          const prop = left.property;
          if (
            obj.type === 'Identifier' &&
            obj.value === functionName &&
            prop.type === 'Identifier' &&
            prop.value === 'workflowId'
          ) {
            const right = expr.right;
            if (right.type === 'StringLiteral') {
              return right.value;
            }
          }
        }
      }
    }
  }
  return null;
}

/**
 * Analyze a workflow function and build its graph
 */
function analyzeWorkflowFunction(
  func: FunctionDeclaration,
  workflowName: string,
  workflowId: string,
  filePath: string,
  stepDeclarations: Map<string, { stepId: string; line: number }>
): WorkflowGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  // Add start node
  nodes.push({
    id: 'start',
    type: 'workflowStart',
    position: { x: 250, y: 0 },
    data: {
      label: `Start: ${workflowName}`,
      nodeKind: 'workflow_start',
      line: func.span.start,
    },
  });

  // Context for control flow analysis
  const context: AnalysisContext = {
    parallelCounter: 0,
    loopCounter: 0,
    conditionalCounter: 0,
    nodeCounter: 0,
    yPosition: 100,
    inLoop: null,
    inConditional: null,
  };

  let prevExitIds = ['start'];

  // Analyze function body
  if (func.body?.stmts) {
    for (const stmt of func.body.stmts) {
      const result = analyzeStatement(stmt, stepDeclarations, context);

      // Add all nodes and edges from this statement
      nodes.push(...result.nodes);
      edges.push(...result.edges);

      // Connect previous exits to this statement's entries
      for (const prevId of prevExitIds) {
        for (const entryId of result.entryNodeIds) {
          // Check if edge already exists
          const edgeId = `e_${prevId}_${entryId}`;
          if (!edges.find((e) => e.id === edgeId)) {
            const targetNode = result.nodes.find((n) => n.id === entryId);
            const edgeType = targetNode?.metadata?.parallelGroupId
              ? 'parallel'
              : targetNode?.metadata?.loopId
                ? 'loop'
                : 'default';
            edges.push({
              id: edgeId,
              source: prevId,
              target: entryId,
              type: edgeType,
            });
          }
        }
      }

      // Update prev exits for next iteration
      if (result.exitNodeIds.length > 0) {
        prevExitIds = result.exitNodeIds;
      }
    }
  }

  // Add end node
  const endY = context.yPosition;
  nodes.push({
    id: 'end',
    type: 'workflowEnd',
    position: { x: 250, y: endY },
    data: {
      label: 'Return',
      nodeKind: 'workflow_end',
      line: func.span.end,
    },
  });

  // Connect last exits to end
  for (const prevId of prevExitIds) {
    edges.push({
      id: `e_${prevId}_end`,
      source: prevId,
      target: 'end',
      type: 'default',
    });
  }

  return {
    workflowId,
    workflowName,
    filePath,
    nodes,
    edges,
  };
}

interface AnalysisContext {
  parallelCounter: number;
  loopCounter: number;
  conditionalCounter: number;
  nodeCounter: number;
  yPosition: number;
  inLoop: string | null;
  inConditional: string | null;
}

interface AnalysisResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  entryNodeIds: string[]; // Nodes that should receive edge from previous
  exitNodeIds: string[]; // Nodes that should send edge to next
}

/**
 * Analyze a statement and extract step calls with proper CFG structure
 */
function analyzeStatement(
  stmt: Statement,
  stepDeclarations: Map<string, { stepId: string; line: number }>,
  context: AnalysisContext
): AnalysisResult {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  let entryNodeIds: string[] = [];
  let exitNodeIds: string[] = [];

  // Variable declaration (const result = await step())
  if (stmt.type === 'VariableDeclaration') {
    const varDecl = stmt as VariableDeclaration;
    for (const decl of varDecl.declarations) {
      if (decl.init) {
        const result = analyzeExpression(decl.init, stepDeclarations, context);
        nodes.push(...result.nodes);
        edges.push(...result.edges);
        if (entryNodeIds.length === 0) {
          entryNodeIds = result.entryNodeIds;
        } else {
          // Connect previous exits to new entries
          for (const prevId of exitNodeIds) {
            for (const entryId of result.entryNodeIds) {
              edges.push({
                id: `e_${prevId}_${entryId}`,
                source: prevId,
                target: entryId,
                type: 'default',
              });
            }
          }
        }
        exitNodeIds = result.exitNodeIds;
      }
    }
  }

  // Expression statement (await step())
  if (stmt.type === 'ExpressionStatement') {
    const result = analyzeExpression(
      stmt.expression,
      stepDeclarations,
      context
    );
    nodes.push(...result.nodes);
    edges.push(...result.edges);
    entryNodeIds = result.entryNodeIds;
    exitNodeIds = result.exitNodeIds;
  }

  // If statement
  if (stmt.type === 'IfStatement') {
    const savedConditional = context.inConditional;
    context.inConditional = `cond_${context.conditionalCounter++}`;

    // Analyze consequent (then branch)
    if (stmt.consequent.type === 'BlockStatement') {
      const branchResult = analyzeBlock(
        stmt.consequent.stmts,
        stepDeclarations,
        context
      );
      nodes.push(...branchResult.nodes);
      edges.push(...branchResult.edges);
      if (entryNodeIds.length === 0) {
        entryNodeIds = branchResult.entryNodeIds;
      }
      exitNodeIds.push(...branchResult.exitNodeIds);
    }

    // Analyze alternate (else branch)
    if (stmt.alternate?.type === 'BlockStatement') {
      const branchResult = analyzeBlock(
        stmt.alternate.stmts,
        stepDeclarations,
        context
      );
      nodes.push(...branchResult.nodes);
      edges.push(...branchResult.edges);
      exitNodeIds.push(...branchResult.exitNodeIds);
    }

    context.inConditional = savedConditional;
  }

  // While/For loops
  if (stmt.type === 'WhileStatement' || stmt.type === 'ForStatement') {
    const loopId = `loop_${context.loopCounter++}`;
    const savedLoop = context.inLoop;
    context.inLoop = loopId;

    const body =
      stmt.type === 'WhileStatement' ? stmt.body : (stmt as any).body;
    if (body.type === 'BlockStatement') {
      const loopResult = analyzeBlock(body.stmts, stepDeclarations, context);

      // Mark all nodes with loop metadata
      for (const node of loopResult.nodes) {
        if (!node.metadata) node.metadata = {};
        node.metadata.loopId = loopId;
      }

      nodes.push(...loopResult.nodes);
      edges.push(...loopResult.edges);
      entryNodeIds = loopResult.entryNodeIds;
      exitNodeIds = loopResult.exitNodeIds;

      // Add loop back-edge from last nodes to first nodes
      for (const exitId of loopResult.exitNodeIds) {
        for (const entryId of loopResult.entryNodeIds) {
          edges.push({
            id: `e_${exitId}_back_${entryId}`,
            source: exitId,
            target: entryId,
            type: 'loop',
          });
        }
      }
    }

    context.inLoop = savedLoop;
  }

  // For-of loops (including `for await...of`)
  if (stmt.type === 'ForOfStatement') {
    const loopId = `loop_${context.loopCounter++}`;
    const savedLoop = context.inLoop;
    context.inLoop = loopId;

    const isAwait = (stmt as any).isAwait || (stmt as any).await;
    const body = (stmt as any).body;

    if (body.type === 'BlockStatement') {
      const loopResult = analyzeBlock(body.stmts, stepDeclarations, context);

      // Mark all nodes with loop metadata
      for (const node of loopResult.nodes) {
        if (!node.metadata) node.metadata = {};
        node.metadata.loopId = loopId;
        node.metadata.loopIsAwait = isAwait;
      }

      nodes.push(...loopResult.nodes);
      edges.push(...loopResult.edges);
      entryNodeIds = loopResult.entryNodeIds;
      exitNodeIds = loopResult.exitNodeIds;

      // Add loop back-edge from last nodes to first nodes
      for (const exitId of loopResult.exitNodeIds) {
        for (const entryId of loopResult.entryNodeIds) {
          edges.push({
            id: `e_${exitId}_back_${entryId}`,
            source: exitId,
            target: entryId,
            type: 'loop',
          });
        }
      }
    }

    context.inLoop = savedLoop;
  }

  // Return statement with expression
  if (stmt.type === 'ReturnStatement' && (stmt as any).argument) {
    const result = analyzeExpression(
      (stmt as any).argument,
      stepDeclarations,
      context
    );
    nodes.push(...result.nodes);
    edges.push(...result.edges);
    entryNodeIds = result.entryNodeIds;
    exitNodeIds = result.exitNodeIds;
  }

  return { nodes, edges, entryNodeIds, exitNodeIds };
}

/**
 * Analyze a block of statements with proper sequential chaining
 */
function analyzeBlock(
  stmts: Statement[],
  stepDeclarations: Map<string, { stepId: string; line: number }>,
  context: AnalysisContext
): AnalysisResult {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  let entryNodeIds: string[] = [];
  let currentExitIds: string[] = [];

  for (const stmt of stmts) {
    const result = analyzeStatement(stmt, stepDeclarations, context);

    if (result.nodes.length === 0) continue;

    nodes.push(...result.nodes);
    edges.push(...result.edges);

    // Set entry nodes from first statement with nodes
    if (entryNodeIds.length === 0 && result.entryNodeIds.length > 0) {
      entryNodeIds = result.entryNodeIds;
    }

    // Connect previous exits to current entries
    if (currentExitIds.length > 0 && result.entryNodeIds.length > 0) {
      for (const prevId of currentExitIds) {
        for (const entryId of result.entryNodeIds) {
          const targetNode = result.nodes.find((n) => n.id === entryId);
          const edgeType = targetNode?.metadata?.parallelGroupId
            ? 'parallel'
            : 'default';
          edges.push({
            id: `e_${prevId}_${entryId}`,
            source: prevId,
            target: entryId,
            type: edgeType,
          });
        }
      }
    }

    // Update exit nodes
    if (result.exitNodeIds.length > 0) {
      currentExitIds = result.exitNodeIds;
    }
  }

  return { nodes, edges, entryNodeIds, exitNodeIds: currentExitIds };
}

/**
 * Analyze an expression and extract step calls
 */
function analyzeExpression(
  expr: Expression,
  stepDeclarations: Map<string, { stepId: string; line: number }>,
  context: AnalysisContext
): AnalysisResult {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const entryNodeIds: string[] = [];
  const exitNodeIds: string[] = [];

  // Await expression
  if (expr.type === 'AwaitExpression') {
    const awaitedExpr = expr.argument;
    if (awaitedExpr.type === 'CallExpression') {
      const callExpr = awaitedExpr as CallExpression;

      // Check for Promise.all/race/allSettled
      if (callExpr.callee.type === 'MemberExpression') {
        const member = callExpr.callee as MemberExpression;
        if (
          member.object.type === 'Identifier' &&
          (member.object as Identifier).value === 'Promise' &&
          member.property.type === 'Identifier'
        ) {
          const method = (member.property as Identifier).value;
          if (['all', 'race', 'allSettled'].includes(method)) {
            // Create a new parallel group for this Promise.all
            const parallelId = `parallel_${context.parallelCounter++}`;

            // Analyze array elements
            if (callExpr.arguments.length > 0) {
              const arg = callExpr.arguments[0].expression;
              if (arg.type === 'ArrayExpression') {
                for (const element of arg.elements) {
                  if (element?.expression) {
                    const elemResult = analyzeExpression(
                      element.expression,
                      stepDeclarations,
                      context
                    );

                    // Set parallel metadata on all nodes from this element
                    for (const node of elemResult.nodes) {
                      if (!node.metadata) node.metadata = {};
                      node.metadata.parallelGroupId = parallelId;
                      node.metadata.parallelMethod = method;
                      // Preserve loop context if we're inside a loop
                      if (context.inLoop) {
                        node.metadata.loopId = context.inLoop;
                      }
                    }

                    nodes.push(...elemResult.nodes);
                    edges.push(...elemResult.edges);
                    entryNodeIds.push(...elemResult.entryNodeIds);
                    exitNodeIds.push(...elemResult.exitNodeIds);
                  }
                }
              }
            }

            return { nodes, edges, entryNodeIds, exitNodeIds };
          }
        }
      }

      // Regular step call
      if (callExpr.callee.type === 'Identifier') {
        const funcName = (callExpr.callee as Identifier).value;
        const stepInfo = stepDeclarations.get(funcName);

        if (stepInfo) {
          const nodeId = `node_${context.nodeCounter++}`;
          const metadata: NodeMetadata = {};

          if (context.inLoop) {
            metadata.loopId = context.inLoop;
          }
          if (context.inConditional) {
            metadata.conditionalId = context.inConditional;
          }

          const node: GraphNode = {
            id: nodeId,
            type: 'step',
            position: { x: 250, y: context.yPosition },
            data: {
              label: funcName,
              nodeKind: 'step',
              stepId: stepInfo.stepId,
              line: expr.span.start,
            },
            metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
          };

          nodes.push(node);
          entryNodeIds.push(nodeId);
          exitNodeIds.push(nodeId);
          context.yPosition += 100;
        }
      }
    }
  }

  // Non-awaited call expression
  if (expr.type === 'CallExpression') {
    const callExpr = expr as CallExpression;
    if (callExpr.callee.type === 'Identifier') {
      const funcName = (callExpr.callee as Identifier).value;
      const stepInfo = stepDeclarations.get(funcName);

      if (stepInfo) {
        const nodeId = `node_${context.nodeCounter++}`;
        const metadata: NodeMetadata = {};

        if (context.inLoop) {
          metadata.loopId = context.inLoop;
        }
        if (context.inConditional) {
          metadata.conditionalId = context.inConditional;
        }

        const node: GraphNode = {
          id: nodeId,
          type: 'step',
          position: { x: 250, y: context.yPosition },
          data: {
            label: funcName,
            nodeKind: 'step',
            stepId: stepInfo.stepId,
            line: expr.span.start,
          },
          metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
        };

        nodes.push(node);
        entryNodeIds.push(nodeId);
        exitNodeIds.push(nodeId);
        context.yPosition += 100;
      }
    }
  }

  return { nodes, edges, entryNodeIds, exitNodeIds };
}
