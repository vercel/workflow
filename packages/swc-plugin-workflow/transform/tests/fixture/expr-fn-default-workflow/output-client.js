/**__internal_workflows{"workflows":{"input.js":{"default":{"workflowId":"workflow//input.js//defaultWorkflow"}}}}*/;
const defaultWorkflow = async function() {
    throw new Error("You attempted to execute workflow defaultWorkflow function directly. To start a workflow, use start(defaultWorkflow) from workflow/api");
};
defaultWorkflow.workflowId = "workflow//input.js//defaultWorkflow";
export default defaultWorkflow;
