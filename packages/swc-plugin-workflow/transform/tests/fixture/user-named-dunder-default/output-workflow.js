/**__internal_workflows{"workflows":{"input.js":{"__default":{"workflowId":"workflow//./input//__default"}}}}*/;
// User explicitly names their workflow function __default
// The workflow ID should use "__default", not normalize to "default"
export async function __default() {
    const result = await someStep();
    return result;
}
__default.workflowId = "workflow//./input//__default";
globalThis.__private_workflows.set("workflow//./input//__default", __default);
