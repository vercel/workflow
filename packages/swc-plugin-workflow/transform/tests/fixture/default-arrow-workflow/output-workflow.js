// Test default export arrow workflow
/**__internal_workflows{"workflows":{"input.js":{"default":{"workflowId":"workflow//./input//default"}}}}*/;
const __default = async (data)=>{
    const processed = await processData(data);
    return processed;
};
__default.workflowId = "workflow//./input//default";
globalThis.__private_workflows.set("workflow//./input//default", __default);
export default __default;
