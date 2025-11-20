// Existing variable named defaultWorkflow
/**__internal_workflows{"workflows":{"input.js":{"default":{"workflowId":"workflow//input.js//defaultWorkflow$1"}}}}*/;
const defaultWorkflow = "existing variable";
// Use it to avoid unused variable
console.log(defaultWorkflow);
const defaultWorkflow$1 = async function() {
    const result = await someStep();
    return result;
};
defaultWorkflow$1.workflowId = "workflow//input.js//defaultWorkflow$1";
export default defaultWorkflow$1;
