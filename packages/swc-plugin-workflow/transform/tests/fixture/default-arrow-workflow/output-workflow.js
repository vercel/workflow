// Test default export arrow workflow
/**__internal_workflows{"workflows":{"input.js":{"default":{"workflowId":"workflow//input.js//default"}}}}*/;
export default defaultWorkflow;
const defaultWorkflow = async (data)=>{
    const processed = await processData(data);
    return processed;
};
defaultWorkflow.workflowId = "workflow//input.js//defaultWorkflow";
