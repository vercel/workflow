// User explicitly names their workflow function __default
// The workflow ID should use "__default", not normalize to "default"
/**__internal_workflows{"workflows":{"input.js":{"__default":{"workflowId":"workflow//input.js//__default"}}}}*/;
export async function __default() {
    const result = await someStep();
    return result;
}
__default.workflowId = "workflow//input.js//__default";
