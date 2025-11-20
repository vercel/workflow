// Existing variable named defaultWorkflow
/**__internal_workflows{"workflows":{"input.js":{"default":{"workflowId":"workflow//input.js//defaultWorkflow$1"}}}}*/;
const defaultWorkflow = "existing variable";
// Use it to avoid unused variable
console.log(defaultWorkflow);
const defaultWorkflow$1 = async function() {
    throw new Error("You attempted to execute workflow defaultWorkflow$1 function directly. To start a workflow, use start(defaultWorkflow$1) from workflow/api");
};
defaultWorkflow$1.workflowId = "workflow//input.js//defaultWorkflow$1";
export default defaultWorkflow$1;
