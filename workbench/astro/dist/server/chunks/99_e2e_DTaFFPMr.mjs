async function add(a, b) {
    return a + b;
}
async function addTenWorkflow(input) {
    throw new Error("You attempted to execute workflow addTenWorkflow function directly. To start a workflow, use start(addTenWorkflow) from workflow/api");
}
addTenWorkflow.workflowId = "workflow//example/workflows/99_e2e.ts//addTenWorkflow";
async function nestedErrorWorkflow() {
    throw new Error("You attempted to execute workflow nestedErrorWorkflow function directly. To start a workflow, use start(nestedErrorWorkflow) from workflow/api");
}
nestedErrorWorkflow.workflowId = "workflow//example/workflows/99_e2e.ts//nestedErrorWorkflow";
async function promiseAllWorkflow() {
    throw new Error("You attempted to execute workflow promiseAllWorkflow function directly. To start a workflow, use start(promiseAllWorkflow) from workflow/api");
}
promiseAllWorkflow.workflowId = "workflow//example/workflows/99_e2e.ts//promiseAllWorkflow";
async function promiseRaceWorkflow() {
    throw new Error("You attempted to execute workflow promiseRaceWorkflow function directly. To start a workflow, use start(promiseRaceWorkflow) from workflow/api");
}
promiseRaceWorkflow.workflowId = "workflow//example/workflows/99_e2e.ts//promiseRaceWorkflow";
async function promiseAnyWorkflow() {
    throw new Error("You attempted to execute workflow promiseAnyWorkflow function directly. To start a workflow, use start(promiseAnyWorkflow) from workflow/api");
}
promiseAnyWorkflow.workflowId = "workflow//example/workflows/99_e2e.ts//promiseAnyWorkflow";
async function readableStreamWorkflow() {
    throw new Error("You attempted to execute workflow readableStreamWorkflow function directly. To start a workflow, use start(readableStreamWorkflow) from workflow/api");
}
readableStreamWorkflow.workflowId = "workflow//example/workflows/99_e2e.ts//readableStreamWorkflow";
async function hookWorkflow(token, customData) {
    throw new Error("You attempted to execute workflow hookWorkflow function directly. To start a workflow, use start(hookWorkflow) from workflow/api");
}
hookWorkflow.workflowId = "workflow//example/workflows/99_e2e.ts//hookWorkflow";
async function webhookWorkflow(token, token2, token3) {
    throw new Error("You attempted to execute workflow webhookWorkflow function directly. To start a workflow, use start(webhookWorkflow) from workflow/api");
}
webhookWorkflow.workflowId = "workflow//example/workflows/99_e2e.ts//webhookWorkflow";
async function sleepingWorkflow() {
    throw new Error("You attempted to execute workflow sleepingWorkflow function directly. To start a workflow, use start(sleepingWorkflow) from workflow/api");
}
sleepingWorkflow.workflowId = "workflow//example/workflows/99_e2e.ts//sleepingWorkflow";
async function nullByteWorkflow() {
    throw new Error("You attempted to execute workflow nullByteWorkflow function directly. To start a workflow, use start(nullByteWorkflow) from workflow/api");
}
nullByteWorkflow.workflowId = "workflow//example/workflows/99_e2e.ts//nullByteWorkflow";
async function workflowAndStepMetadataWorkflow() {
    throw new Error("You attempted to execute workflow workflowAndStepMetadataWorkflow function directly. To start a workflow, use start(workflowAndStepMetadataWorkflow) from workflow/api");
}
workflowAndStepMetadataWorkflow.workflowId = "workflow//example/workflows/99_e2e.ts//workflowAndStepMetadataWorkflow";
async function outputStreamWorkflow() {
    throw new Error("You attempted to execute workflow outputStreamWorkflow function directly. To start a workflow, use start(outputStreamWorkflow) from workflow/api");
}
outputStreamWorkflow.workflowId = "workflow//example/workflows/99_e2e.ts//outputStreamWorkflow";
async function outputStreamInsideStepWorkflow() {
    throw new Error("You attempted to execute workflow outputStreamInsideStepWorkflow function directly. To start a workflow, use start(outputStreamInsideStepWorkflow) from workflow/api");
}
outputStreamInsideStepWorkflow.workflowId = "workflow//example/workflows/99_e2e.ts//outputStreamInsideStepWorkflow";
async function fetchWorkflow() {
    throw new Error("You attempted to execute workflow fetchWorkflow function directly. To start a workflow, use start(fetchWorkflow) from workflow/api");
}
fetchWorkflow.workflowId = "workflow//example/workflows/99_e2e.ts//fetchWorkflow";
async function promiseRaceStressTestDelayStep(dur, resp) {
    console.log(`sleep`, resp, `/`, dur);
    await new Promise((resolve)=>setTimeout(resolve, dur));
    console.log(resp, `done`);
    return resp;
}
async function promiseRaceStressTestWorkflow() {
    throw new Error("You attempted to execute workflow promiseRaceStressTestWorkflow function directly. To start a workflow, use start(promiseRaceStressTestWorkflow) from workflow/api");
}
promiseRaceStressTestWorkflow.workflowId = "workflow//example/workflows/99_e2e.ts//promiseRaceStressTestWorkflow";
async function retryAttemptCounterWorkflow() {
    throw new Error("You attempted to execute workflow retryAttemptCounterWorkflow function directly. To start a workflow, use start(retryAttemptCounterWorkflow) from workflow/api");
}
retryAttemptCounterWorkflow.workflowId = "workflow//example/workflows/99_e2e.ts//retryAttemptCounterWorkflow";
async function crossFileErrorWorkflow() {
    throw new Error("You attempted to execute workflow crossFileErrorWorkflow function directly. To start a workflow, use start(crossFileErrorWorkflow) from workflow/api");
}
crossFileErrorWorkflow.workflowId = "workflow//example/workflows/99_e2e.ts//crossFileErrorWorkflow";
async function retryableAndFatalErrorWorkflow() {
    throw new Error("You attempted to execute workflow retryableAndFatalErrorWorkflow function directly. To start a workflow, use start(retryableAndFatalErrorWorkflow) from workflow/api");
}
retryableAndFatalErrorWorkflow.workflowId = "workflow//example/workflows/99_e2e.ts//retryableAndFatalErrorWorkflow";
async function hookCleanupTestWorkflow(token, customData) {
    throw new Error("You attempted to execute workflow hookCleanupTestWorkflow function directly. To start a workflow, use start(hookCleanupTestWorkflow) from workflow/api");
}
hookCleanupTestWorkflow.workflowId = "workflow//example/workflows/99_e2e.ts//hookCleanupTestWorkflow";
async function stepFunctionPassingWorkflow() {
    throw new Error("You attempted to execute workflow stepFunctionPassingWorkflow function directly. To start a workflow, use start(stepFunctionPassingWorkflow) from workflow/api");
}
stepFunctionPassingWorkflow.workflowId = "workflow//example/workflows/99_e2e.ts//stepFunctionPassingWorkflow";

const workflow_99_e2e = /*#__PURE__*/Object.freeze(/*#__PURE__*/Object.defineProperty({
  __proto__: null,
  add,
  addTenWorkflow,
  crossFileErrorWorkflow,
  fetchWorkflow,
  hookCleanupTestWorkflow,
  hookWorkflow,
  nestedErrorWorkflow,
  nullByteWorkflow,
  outputStreamInsideStepWorkflow,
  outputStreamWorkflow,
  promiseAllWorkflow,
  promiseAnyWorkflow,
  promiseRaceStressTestDelayStep,
  promiseRaceStressTestWorkflow,
  promiseRaceWorkflow,
  readableStreamWorkflow,
  retryAttemptCounterWorkflow,
  retryableAndFatalErrorWorkflow,
  sleepingWorkflow,
  stepFunctionPassingWorkflow,
  webhookWorkflow,
  workflowAndStepMetadataWorkflow
}, Symbol.toStringTag, { value: 'Module' }));

export { add as a, workflow_99_e2e as w };
