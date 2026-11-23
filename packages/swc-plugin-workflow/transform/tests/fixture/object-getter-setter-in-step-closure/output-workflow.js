/**__internal_workflows{"workflows":{"input.js":{"outer":{"workflowId":"workflow//./input//outer"},"wf":{"workflowId":"workflow//./input//wf"}}},"steps":{"input.js":{"api/value":{"stepId":"step//./input//api/value"},"outer/nested/thing":{"stepId":"step//./input//outer/nested/thing"},"wf/helper":{"stepId":"step//./input//wf/helper"}}}}*/;
var __step_api$value = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//api/value");
var __step_outer$nested$thing = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//outer/nested/thing");
export async function wf(input) {
    const prefix = input.prefix;
    const helper = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//wf/helper", ()=>({
            prefix
        }));
    return await helper(1);
}
wf.workflowId = "workflow//./input//wf";
globalThis.__private_workflows.set("workflow//./input//wf", wf);
export const api = {
    get value () {
        return __step_api$value();
    },
    set value (v){
        console.log(v);
    },
    get ['~id'] () {
        'use step';
        return 2;
    }
};
export async function outer() {
    const nested = {
        get thing () {
            return __step_outer$nested$thing();
        }
    };
    return nested.thing;
}
outer.workflowId = "workflow//./input//outer";
globalThis.__private_workflows.set("workflow//./input//outer", outer);
