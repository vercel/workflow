/**__internal_workflows{"workflows":{"input.js":{"myWorkflow":{"workflowId":"workflow//./input//myWorkflow"}}}}*/;
// This is the TypeScript-transformed output of:
// async function myWorkflow() {
//   'use workflow';
//   using resource = getResource();
//   return await processData(resource);
// }
export async function myWorkflow() {
    const env = {
        stack: [],
        error: void 0,
        hasError: false
    };
    try {
        const resource = env.stack.push({
            value: "test"
        });
        return await Promise.resolve(resource);
    } catch (e) {
        env.error = e;
        env.hasError = true;
    } finally{
        env.stack.pop();
    }
}
myWorkflow.workflowId = "workflow//./input//myWorkflow";
globalThis.__private_workflows.set("workflow//./input//myWorkflow", myWorkflow);
