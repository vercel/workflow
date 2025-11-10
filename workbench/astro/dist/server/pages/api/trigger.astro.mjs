import { R as Run, g as getRun } from '../../chunks/runtime_CxdH0OC2.mjs';
import { w as waitedUntil, e as WorkflowRuntimeError, t as trace, o as WorkflowOperation, l as WorkflowName, p as WorkflowArgumentsCount, c as getWorld, q as dehydrateWorkflowArguments, s as serializeTraceCarrier, k as functionsExports, D as DeploymentId, u as WorkflowRunStatus, f as WorkflowRunId, v as hydrateWorkflowArguments, x as WorkflowRunNotCompletedError, y as WorkflowRunFailedError } from '../../chunks/index_ePTMDSOu.mjs';
import { w as workflow_99_e2e } from '../../chunks/99_e2e_DTaFFPMr.mjs';
export { renderers } from '../../renderers.mjs';

async function start(workflow, argsOrOptions, options) {
    return await waitedUntil(()=>{
        // @ts-expect-error this field is added by our client transform
        const workflowName = workflow.workflowId;
        if (!workflowName) {
            throw new WorkflowRuntimeError(`'start' received an invalid workflow function. Ensure the Workflow Development Kit is configured correctly and the function includes a 'use workflow' directive.`, {
                slug: 'start-invalid-workflow-function'
            });
        }
        return trace(`WORKFLOW.start ${workflowName}`, async (span)=>{
            span?.setAttributes({
                ...WorkflowName(workflowName),
                ...WorkflowOperation('start')
            });
            let args = [];
            let opts = {};
            if (Array.isArray(argsOrOptions)) {
                args = argsOrOptions;
            } else if (typeof argsOrOptions === 'object') {
                opts = argsOrOptions;
            }
            span?.setAttributes({
                ...WorkflowArgumentsCount(args.length)
            });
            const world = getWorld();
            const deploymentId = opts.deploymentId ?? await world.getDeploymentId();
            const ops = [];
            const workflowArguments = dehydrateWorkflowArguments(args, ops);
            // Serialize current trace context to propagate across queue boundary
            const traceCarrier = await serializeTraceCarrier();
            const runResponse = await world.runs.create({
                deploymentId: deploymentId,
                workflowName: workflowName,
                input: workflowArguments,
                executionContext: {
                    traceCarrier
                }
            });
            functionsExports.waitUntil(Promise.all(ops));
            span?.setAttributes({
                ...WorkflowRunId(runResponse.runId),
                ...WorkflowRunStatus(runResponse.status),
                ...DeploymentId(deploymentId)
            });
            await world.queue(`__wkf_workflow_${workflowName}`, {
                runId: runResponse.runId,
                traceCarrier
            }, {
                deploymentId
            });
            return new Run(runResponse.runId);
        });
    });
}

async function calc(n) {
    throw new Error("You attempted to execute workflow calc function directly. To start a workflow, use start(calc) from workflow/api");
}
calc.workflowId = "workflow//nitro-v3/workflows/0_demo.ts//calc";

const workflow_0_demo = /*#__PURE__*/Object.freeze(/*#__PURE__*/Object.defineProperty({
    __proto__: null,
    calc
}, Symbol.toStringTag, { value: 'Module' }));

async function simple(i) {
    throw new Error("You attempted to execute workflow simple function directly. To start a workflow, use start(simple) from workflow/api");
}
simple.workflowId = "workflow//example/workflows/1_simple.ts//simple";

const workflow_1_simple = /*#__PURE__*/Object.freeze(/*#__PURE__*/Object.defineProperty({
    __proto__: null,
    simple
}, Symbol.toStringTag, { value: 'Module' }));

async function control_flow() {
    throw new Error("You attempted to execute workflow control_flow function directly. To start a workflow, use start(control_flow) from workflow/api");
}
control_flow.workflowId = "workflow//example/workflows/2_control_flow.ts//control_flow";

const workflow_2_control_flow = /*#__PURE__*/Object.freeze(/*#__PURE__*/Object.defineProperty({
    __proto__: null,
    control_flow
}, Symbol.toStringTag, { value: 'Module' }));

async function genStream() {
    const stream = new ReadableStream({
        async start (controller) {
            const encoder = new TextEncoder();
            for(let i = 0; i < 30; i++){
                const chunk = encoder.encode(`${i}
`);
                controller.enqueue(chunk);
                console.log(`Enqueued number: ${i}`);
                await new Promise((resolve)=>setTimeout(resolve, 2500));
            }
            controller.close();
        }
    });
    return stream;
}
async function consumeStreams(...streams2) {
    const parts = [];
    console.log("Consuming streams", streams2);
    await Promise.all(streams2.map(async (s, i)=>{
        const reader = s.getReader();
        while(true){
            const result = await reader.read();
            if (result.done) break;
            console.log(`Received ${result.value.length} bytes from stream ${i}: ${JSON.stringify(new TextDecoder().decode(result.value))}`);
            parts.push(result.value);
        }
    }));
    return Buffer.concat(parts).toString("utf8");
}
async function streams() {
    throw new Error("You attempted to execute workflow streams function directly. To start a workflow, use start(streams) from workflow/api");
}
streams.workflowId = "workflow//example/workflows/3_streams.ts//streams";

const workflow_3_streams = /*#__PURE__*/Object.freeze(/*#__PURE__*/Object.defineProperty({
    __proto__: null,
    consumeStreams,
    genStream,
    streams
}, Symbol.toStringTag, { value: 'Module' }));

async function ai(prompt) {
    throw new Error("You attempted to execute workflow ai function directly. To start a workflow, use start(ai) from workflow/api");
}
ai.workflowId = "workflow//example/workflows/4_ai.ts//ai";
async function agent(prompt) {
    throw new Error("You attempted to execute workflow agent function directly. To start a workflow, use start(agent) from workflow/api");
}
agent.workflowId = "workflow//example/workflows/4_ai.ts//agent";

const workflow_4_ai = /*#__PURE__*/Object.freeze(/*#__PURE__*/Object.defineProperty({
    __proto__: null,
    agent,
    ai
}, Symbol.toStringTag, { value: 'Module' }));

async function withWorkflowMetadata() {
    throw new Error("You attempted to execute workflow withWorkflowMetadata function directly. To start a workflow, use start(withWorkflowMetadata) from workflow/api");
}
withWorkflowMetadata.workflowId = "workflow//example/workflows/5_hooks.ts//withWorkflowMetadata";
async function withCreateHook() {
    throw new Error("You attempted to execute workflow withCreateHook function directly. To start a workflow, use start(withCreateHook) from workflow/api");
}
withCreateHook.workflowId = "workflow//example/workflows/5_hooks.ts//withCreateHook";

const workflow_5_hooks = /*#__PURE__*/Object.freeze(/*#__PURE__*/Object.defineProperty({
    __proto__: null,
    withCreateHook,
    withWorkflowMetadata
}, Symbol.toStringTag, { value: 'Module' }));

async function batchOverSteps() {
    throw new Error("You attempted to execute workflow batchOverSteps function directly. To start a workflow, use start(batchOverSteps) from workflow/api");
}
batchOverSteps.workflowId = "workflow//example/workflows/6_batching.ts//batchOverSteps";
async function batchInStep() {
    throw new Error("You attempted to execute workflow batchInStep function directly. To start a workflow, use start(batchInStep) from workflow/api");
}
batchInStep.workflowId = "workflow//example/workflows/6_batching.ts//batchInStep";

const workflow_6_batching = /*#__PURE__*/Object.freeze(/*#__PURE__*/Object.defineProperty({
    __proto__: null,
    batchInStep,
    batchOverSteps
}, Symbol.toStringTag, { value: 'Module' }));

async function handleUserSignup(email) {
    throw new Error("You attempted to execute workflow handleUserSignup function directly. To start a workflow, use start(handleUserSignup) from workflow/api");
}
handleUserSignup.workflowId = "workflow//example/workflows/7_full.ts//handleUserSignup";

const workflow_7_full = /*#__PURE__*/Object.freeze(/*#__PURE__*/Object.defineProperty({
    __proto__: null,
    handleUserSignup
}, Symbol.toStringTag, { value: 'Module' }));

async function addTenWorkflow(input) {
    throw new Error("You attempted to execute workflow addTenWorkflow function directly. To start a workflow, use start(addTenWorkflow) from workflow/api");
}
addTenWorkflow.workflowId = "workflow//example/workflows/98_duplicate_case.ts//addTenWorkflow";
async function add(a, b) {
    return a + b;
}

const workflow_98_duplicate_case = /*#__PURE__*/Object.freeze(/*#__PURE__*/Object.defineProperty({
    __proto__: null,
    add,
    addTenWorkflow
}, Symbol.toStringTag, { value: 'Module' }));

const allWorkflows = {
  "workflows/0_demo.ts": workflow_0_demo,
  "workflows/1_simple.ts": workflow_1_simple,
  "workflows/2_control_flow.ts": workflow_2_control_flow,
  "workflows/3_streams.ts": workflow_3_streams,
  "workflows/4_ai.ts": workflow_4_ai,
  "workflows/5_hooks.ts": workflow_5_hooks,
  "workflows/6_batching.ts": workflow_6_batching,
  "workflows/7_full.ts": workflow_7_full,
  "workflows/98_duplicate_case.ts": workflow_98_duplicate_case,
  "workflows/99_e2e.ts": workflow_99_e2e
};

async function POST({ request }) {
  const url = new URL(request.url);
  const workflowFile = url.searchParams.get("workflowFile") || "workflows/99_e2e.ts";
  const workflows = allWorkflows[workflowFile];
  if (!workflows) {
    return new Response(`Workflow file "${workflowFile}" not found`, {
      status: 400
    });
  }
  const workflowFn = url.searchParams.get("workflowFn") || "simple";
  const workflow = workflows[workflowFn];
  if (!workflow) {
    return new Response(`Workflow "${workflowFn}" not found`, { status: 400 });
  }
  let args = [];
  const argsParam = url.searchParams.get("args");
  if (argsParam) {
    args = argsParam.split(",").map((arg) => {
      const num = parseFloat(arg);
      return Number.isNaN(num) ? arg.trim() : num;
    });
  } else {
    const body = await request.text();
    if (body) {
      args = hydrateWorkflowArguments(JSON.parse(body), globalThis);
    } else {
      args = [42];
    }
  }
  console.log(`Starting "${workflowFn}" workflow with args: ${args}`);
  try {
    const run = await start(workflow, args);
    console.log("Run:", run);
    return Response.json(run);
  } catch (err) {
    console.error(`Failed to start!!`, err);
    throw err;
  }
}
const GET = async ({ request }) => {
  const url = new URL(request.url);
  const runId = url.searchParams.get("runId");
  if (!runId) {
    return new Response("No runId provided", { status: 400 });
  }
  const outputStreamParam = url.searchParams.get("output-stream");
  if (outputStreamParam) {
    const namespace = outputStreamParam === "1" ? void 0 : outputStreamParam;
    const run = getRun(runId);
    const stream = run.getReadable({
      namespace
    });
    const streamWithFraming = new TransformStream({
      transform(chunk, controller) {
        const data = chunk instanceof Uint8Array ? { data: Buffer.from(chunk).toString("base64") } : chunk;
        controller.enqueue(`${JSON.stringify(data)}
`);
      }
    });
    return new Response(stream.pipeThrough(streamWithFraming), {
      headers: {
        "Content-Type": "application/octet-stream"
      }
    });
  }
  try {
    const run = getRun(runId);
    const returnValue = await run.returnValue;
    console.log("Return value:", returnValue);
    return returnValue instanceof ReadableStream ? new Response(returnValue, {
      headers: {
        "Content-Type": "application/octet-stream"
      }
    }) : Response.json(returnValue);
  } catch (error) {
    if (error instanceof Error) {
      if (WorkflowRunNotCompletedError.is(error)) {
        return Response.json(
          {
            ...error,
            name: error.name,
            message: error.message
          },
          { status: 202 }
        );
      }
      if (WorkflowRunFailedError.is(error)) {
        const cause = error.cause;
        return Response.json(
          {
            ...error,
            name: error.name,
            message: error.message,
            cause: {
              message: cause.message,
              stack: cause.stack,
              code: cause.code
            }
          },
          { status: 400 }
        );
      }
    }
    console.error(
      "Unexpected error while getting workflow return value:",
      error
    );
    return Response.json(
      {
        error: "Internal server error"
      },
      { status: 500 }
    );
  }
};
const prerender = false;

const _page = /*#__PURE__*/Object.freeze(/*#__PURE__*/Object.defineProperty({
    __proto__: null,
    GET,
    POST,
    prerender
}, Symbol.toStringTag, { value: 'Module' }));

const page = () => _page;

export { page };
