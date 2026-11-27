/**__internal_workflows{"workflows":{"input.ts":{"wf":{"workflowId":"workflow//./input//wf"}}},"steps":{"input.ts":{"Svc#method":{"stepId":"step//./input//Svc#method"},"stepWithThis":{"stepId":"step//./input//stepWithThis"},"wf/nested":{"stepId":"step//./input//wf/nested"}}},"classes":{"input.ts":{"Svc":{"classId":"class//./input//Svc"}}}}*/;
interface Ctx {
    prefix: string;
}
export var stepWithThis = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//stepWithThis");
export async function wf(input: {
    name: string;
}) {
    const local = 'x';
    const nested = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//wf/nested", ()=>({
            local
        }));
    return await nested.call({
        prefix: ''
    }, 1);
}
wf.workflowId = "workflow//./input//wf";
globalThis.__private_workflows.set("workflow//./input//wf", wf);
export class Svc {
}
Svc.prototype["method"] = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//Svc#method");
(function(__wf_cls, __wf_id) {
    var __wf_sym = Symbol.for("workflow-class-registry"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_cls);
    if (!Object.prototype.hasOwnProperty.call(__wf_cls, "classId")) Object.defineProperty(__wf_cls, "classId", {
        value: __wf_id,
        writable: false,
        enumerable: false,
        configurable: false
    });
})(Svc, "class//./input//Svc");
