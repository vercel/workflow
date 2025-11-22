// Test default export arrow workflow
/**__internal_workflows{"workflows":{"input.js":{"default":{"workflowId":"workflow//input.js//__default"}}}}*/;
export default (async (data)=>{
    'use workflow';
    const processed = await processData(data);
    return processed;
});
