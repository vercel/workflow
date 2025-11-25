import { readFile } from 'node:fs/promises';
import type {
  ArrowFunctionExpression,
  BlockStatement,
  CallExpression,
  Expression,
  FunctionDeclaration,
  FunctionExpression,
  Identifier,
  MemberExpression,
  Program,
  Statement,
  VariableDeclaration,
} from '@swc/core';
import { parseSync } from '@swc/core';

/**
 * Represents a function in the bundle (can be declaration, expression, or arrow)
 */
interface FunctionInfo {
  name: string;
  body: BlockStatement | Expression | null | undefined;
  isStep: boolean;
  stepId?: string;
}

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
  conditionalBranch?: 'Then' | 'Else';
  parallelGroupId?: string;
  parallelMethod?: string;
  /** Step is passed as a reference (callback/tool) rather than directly called */
  isStepReference?: boolean;
  /** Context where the step reference was found (e.g., "tools.getWeather.execute") */
  referenceContext?: string;
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

    // Build a map of ALL functions in the bundle (for transitive step resolution)
    const functionMap = buildFunctionMap(ast, stepDeclarations);

    // Extract workflows with transitive step resolution
    const workflows = extractWorkflows(ast, stepDeclarations, functionMap);

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
 * Build a map of all functions in the bundle for transitive step resolution
 */
function buildFunctionMap(
  ast: Program,
  stepDeclarations: Map<string, { stepId: string; line: number }>
): Map<string, FunctionInfo> {
  const functionMap = new Map<string, FunctionInfo>();

  for (const item of ast.body) {
    // Handle function declarations: function foo() {}
    if (item.type === 'FunctionDeclaration') {
      const func = item as FunctionDeclaration;
      if (func.identifier) {
        const name = func.identifier.value;
        const isStep = stepDeclarations.has(name);
        functionMap.set(name, {
          name,
          body: func.body,
          isStep,
          stepId: isStep ? stepDeclarations.get(name)?.stepId : undefined,
        });
      }
    }

    // Handle variable declarations: const foo = function() {} or const foo = () => {}
    if (item.type === 'VariableDeclaration') {
      const varDecl = item as VariableDeclaration;
      for (const decl of varDecl.declarations) {
        if (decl.id.type === 'Identifier' && decl.init) {
          const name = decl.id.value;
          const isStep = stepDeclarations.has(name);

          if (decl.init.type === 'FunctionExpression') {
            const funcExpr = decl.init as FunctionExpression;
            functionMap.set(name, {
              name,
              body: funcExpr.body,
              isStep,
              stepId: isStep ? stepDeclarations.get(name)?.stepId : undefined,
            });
          } else if (decl.init.type === 'ArrowFunctionExpression') {
            const arrowFunc = decl.init as ArrowFunctionExpression;
            functionMap.set(name, {
              name,
              body: arrowFunc.body,
              isStep,
              stepId: isStep ? stepDeclarations.get(name)?.stepId : undefined,
            });
          }
        }
      }
    }
  }

  return functionMap;
}

/**
 * Extract workflows from AST
 */
function extractWorkflows(
  ast: Program,
  stepDeclarations: Map<string, { stepId: string; line: number }>,
  functionMap: Map<string, FunctionInfo>
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

      // Analyze the function body with transitive step resolution
      const graph = analyzeWorkflowFunction(
        func,
        workflowName,
        workflowId,
        filePath,
        stepDeclarations,
        functionMap
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
  stepDeclarations: Map<string, { stepId: string; line: number }>,
  functionMap: Map<string, FunctionInfo>
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
      const result = analyzeStatement(
        stmt,
        stepDeclarations,
        context,
        functionMap
      );

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
  context: AnalysisContext,
  functionMap: Map<string, FunctionInfo>
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
        const result = analyzeExpression(
          decl.init,
          stepDeclarations,
          context,
          functionMap
        );
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
      context,
      functionMap
    );
    nodes.push(...result.nodes);
    edges.push(...result.edges);
    entryNodeIds = result.entryNodeIds;
    exitNodeIds = result.exitNodeIds;
  }

  // If statement
  if (stmt.type === 'IfStatement') {
    const savedConditional = context.inConditional;
    const conditionalId = `cond_${context.conditionalCounter++}`;
    context.inConditional = conditionalId;

    // Analyze consequent (then branch)
    if (stmt.consequent.type === 'BlockStatement') {
      const branchResult = analyzeBlock(
        stmt.consequent.stmts,
        stepDeclarations,
        context,
        functionMap
      );

      // Mark all nodes with conditional metadata for 'Then' branch
      for (const node of branchResult.nodes) {
        if (!node.metadata) node.metadata = {};
        node.metadata.conditionalId = conditionalId;
        node.metadata.conditionalBranch = 'Then';
      }

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
        context,
        functionMap
      );

      // Mark all nodes with conditional metadata for 'Else' branch
      for (const node of branchResult.nodes) {
        if (!node.metadata) node.metadata = {};
        node.metadata.conditionalId = conditionalId;
        node.metadata.conditionalBranch = 'Else';
      }

      nodes.push(...branchResult.nodes);
      edges.push(...branchResult.edges);
      // Add else branch entries to entryNodeIds for proper edge connection
      if (entryNodeIds.length === 0) {
        entryNodeIds = branchResult.entryNodeIds;
      } else {
        entryNodeIds.push(...branchResult.entryNodeIds);
      }
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
      const loopResult = analyzeBlock(
        body.stmts,
        stepDeclarations,
        context,
        functionMap
      );

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
      const loopResult = analyzeBlock(
        body.stmts,
        stepDeclarations,
        context,
        functionMap
      );

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
      context,
      functionMap
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
  context: AnalysisContext,
  functionMap: Map<string, FunctionInfo>
): AnalysisResult {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  let entryNodeIds: string[] = [];
  let currentExitIds: string[] = [];

  for (const stmt of stmts) {
    const result = analyzeStatement(
      stmt,
      stepDeclarations,
      context,
      functionMap
    );

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
 * Analyze an expression and extract step calls (including transitive calls through helper functions)
 */
function analyzeExpression(
  expr: Expression,
  stepDeclarations: Map<string, { stepId: string; line: number }>,
  context: AnalysisContext,
  functionMap: Map<string, FunctionInfo>,
  visitedFunctions: Set<string> = new Set() // Prevent infinite recursion
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
                      context,
                      functionMap,
                      visitedFunctions
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

      // Regular call - check if it's a step or a helper function
      if (callExpr.callee.type === 'Identifier') {
        const funcName = (callExpr.callee as Identifier).value;
        const stepInfo = stepDeclarations.get(funcName);

        if (stepInfo) {
          // Direct step call
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
        } else {
          // Check if it's a helper function - analyze transitively
          const transitiveResult = analyzeTransitiveCall(
            funcName,
            stepDeclarations,
            context,
            functionMap,
            visitedFunctions,
            expr.span.start
          );
          nodes.push(...transitiveResult.nodes);
          edges.push(...transitiveResult.edges);
          entryNodeIds.push(...transitiveResult.entryNodeIds);
          exitNodeIds.push(...transitiveResult.exitNodeIds);
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
        // Direct step call
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
      } else {
        // Check if it's a helper function - analyze transitively
        const transitiveResult = analyzeTransitiveCall(
          funcName,
          stepDeclarations,
          context,
          functionMap,
          visitedFunctions,
          expr.span.start
        );
        nodes.push(...transitiveResult.nodes);
        edges.push(...transitiveResult.edges);
        entryNodeIds.push(...transitiveResult.entryNodeIds);
        exitNodeIds.push(...transitiveResult.exitNodeIds);
      }
    }
  }

  // Check for step references in object literals (e.g., { execute: stepFunc, tools: { ... } })
  if (expr.type === 'ObjectExpression') {
    const refResult = analyzeObjectForStepReferences(
      expr,
      stepDeclarations,
      context,
      ''
    );
    nodes.push(...refResult.nodes);
    edges.push(...refResult.edges);
    entryNodeIds.push(...refResult.entryNodeIds);
    exitNodeIds.push(...refResult.exitNodeIds);
  }

  // Check for step references in function call arguments
  if (expr.type === 'CallExpression') {
    const callExpr = expr as CallExpression;
    for (const arg of callExpr.arguments) {
      if (arg.expression) {
        // Check if argument is a step reference
        if (arg.expression.type === 'Identifier') {
          const argName = (arg.expression as Identifier).value;
          const stepInfo = stepDeclarations.get(argName);
          if (stepInfo) {
            const nodeId = `node_${context.nodeCounter++}`;
            const node: GraphNode = {
              id: nodeId,
              type: 'step',
              position: { x: 250, y: context.yPosition },
              data: {
                label: `${argName} (ref)`,
                nodeKind: 'step',
                stepId: stepInfo.stepId,
                line: arg.expression.span.start,
              },
              metadata: {
                isStepReference: true,
                referenceContext: 'function argument',
              },
            };
            nodes.push(node);
            entryNodeIds.push(nodeId);
            exitNodeIds.push(nodeId);
            context.yPosition += 100;
          }
        }
        // Check for object literals in arguments
        if (arg.expression.type === 'ObjectExpression') {
          const refResult = analyzeObjectForStepReferences(
            arg.expression,
            stepDeclarations,
            context,
            ''
          );
          nodes.push(...refResult.nodes);
          edges.push(...refResult.edges);
          entryNodeIds.push(...refResult.entryNodeIds);
          exitNodeIds.push(...refResult.exitNodeIds);
        }
      }
    }
  }

  // Check for step references in 'new' expressions (e.g., new DurableAgent({ tools: ... }))
  if (expr.type === 'NewExpression') {
    const newExpr = expr as any;
    if (newExpr.arguments) {
      for (const arg of newExpr.arguments) {
        if (arg.expression?.type === 'ObjectExpression') {
          const refResult = analyzeObjectForStepReferences(
            arg.expression,
            stepDeclarations,
            context,
            ''
          );
          nodes.push(...refResult.nodes);
          edges.push(...refResult.edges);
          entryNodeIds.push(...refResult.entryNodeIds);
          exitNodeIds.push(...refResult.exitNodeIds);
        }
      }
    }
  }

  return { nodes, edges, entryNodeIds, exitNodeIds };
}

/**
 * Analyze an object expression for step references (e.g., { execute: stepFunc })
 */
function analyzeObjectForStepReferences(
  obj: any,
  stepDeclarations: Map<string, { stepId: string; line: number }>,
  context: AnalysisContext,
  path: string
): AnalysisResult {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const entryNodeIds: string[] = [];
  const exitNodeIds: string[] = [];

  if (!obj.properties) return { nodes, edges, entryNodeIds, exitNodeIds };

  for (const prop of obj.properties) {
    if (prop.type !== 'KeyValueProperty') continue;

    // Get property key name
    let keyName = '';
    if (prop.key.type === 'Identifier') {
      keyName = prop.key.value;
    } else if (prop.key.type === 'StringLiteral') {
      keyName = prop.key.value;
    }

    const currentPath = path ? `${path}.${keyName}` : keyName;

    // Check if the value is a step reference
    if (prop.value.type === 'Identifier') {
      const valueName = prop.value.value;
      const stepInfo = stepDeclarations.get(valueName);
      if (stepInfo) {
        const nodeId = `node_${context.nodeCounter++}`;
        const node: GraphNode = {
          id: nodeId,
          type: 'step',
          position: { x: 250, y: context.yPosition },
          data: {
            label: `${valueName} (tool)`,
            nodeKind: 'step',
            stepId: stepInfo.stepId,
            line: prop.value.span.start,
          },
          metadata: {
            isStepReference: true,
            referenceContext: currentPath,
          },
        };
        nodes.push(node);
        entryNodeIds.push(nodeId);
        exitNodeIds.push(nodeId);
        context.yPosition += 100;
      }
    }

    // Recursively check nested objects
    if (prop.value.type === 'ObjectExpression') {
      const nestedResult = analyzeObjectForStepReferences(
        prop.value,
        stepDeclarations,
        context,
        currentPath
      );
      nodes.push(...nestedResult.nodes);
      edges.push(...nestedResult.edges);
      entryNodeIds.push(...nestedResult.entryNodeIds);
      exitNodeIds.push(...nestedResult.exitNodeIds);
    }
  }

  return { nodes, edges, entryNodeIds, exitNodeIds };
}

/**
 * Analyze a transitive function call to find step calls within helper functions
 */
function analyzeTransitiveCall(
  funcName: string,
  stepDeclarations: Map<string, { stepId: string; line: number }>,
  context: AnalysisContext,
  functionMap: Map<string, FunctionInfo>,
  visitedFunctions: Set<string>,
  _callLine: number // Reserved for future debug info
): AnalysisResult {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const entryNodeIds: string[] = [];
  const exitNodeIds: string[] = [];

  // Prevent infinite recursion
  if (visitedFunctions.has(funcName)) {
    return { nodes, edges, entryNodeIds, exitNodeIds };
  }

  // Look up the function in our map
  const funcInfo = functionMap.get(funcName);
  if (!funcInfo || funcInfo.isStep) {
    // Not a helper function or already a step
    return { nodes, edges, entryNodeIds, exitNodeIds };
  }

  // Mark as visited to prevent cycles
  visitedFunctions.add(funcName);

  try {
    // Analyze the function body
    if (funcInfo.body) {
      if (funcInfo.body.type === 'BlockStatement') {
        // Function body is a block statement
        const bodyResult = analyzeBlock(
          funcInfo.body.stmts,
          stepDeclarations,
          context,
          functionMap
        );
        nodes.push(...bodyResult.nodes);
        edges.push(...bodyResult.edges);
        entryNodeIds.push(...bodyResult.entryNodeIds);
        exitNodeIds.push(...bodyResult.exitNodeIds);
      } else {
        // Arrow function with expression body
        const exprResult = analyzeExpression(
          funcInfo.body,
          stepDeclarations,
          context,
          functionMap,
          visitedFunctions
        );
        nodes.push(...exprResult.nodes);
        edges.push(...exprResult.edges);
        entryNodeIds.push(...exprResult.entryNodeIds);
        exitNodeIds.push(...exprResult.exitNodeIds);
      }
    }
  } finally {
    // Unmark after analysis to allow the same function to be called multiple times
    // (just not recursively)
    visitedFunctions.delete(funcName);
  }

  return { nodes, edges, entryNodeIds, exitNodeIds };
}
