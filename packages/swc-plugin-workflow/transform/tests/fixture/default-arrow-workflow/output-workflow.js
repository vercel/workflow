// Test default export arrow workflow
/**__internal_workflows{"workflows":{"input.js":{"default":{"workflowId":"workflow//input.js//default"}}}}*/;
const __default = async (data)=>{
    const processed = await processData(data);
    return processed;
};
__default.workflowId = "workflow//input.js//default";
export default __default;
