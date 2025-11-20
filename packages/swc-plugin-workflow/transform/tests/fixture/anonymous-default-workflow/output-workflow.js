// Test anonymous default export workflow
/**__internal_workflows{"workflows":{"input.js":{"default":{"workflowId":"workflow//input.js//defaultWorkflow"}}}}*/;
const defaultWorkflow = async function() {
    const result = await someStep();
    return result;
};
defaultWorkflow.workflowId = "workflow//input.js//defaultWorkflow";
export default defaultWorkflow;
