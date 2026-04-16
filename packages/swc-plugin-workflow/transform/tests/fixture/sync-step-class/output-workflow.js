/**__internal_workflows{"workflows":{"input.js":{"Service.run":{"workflowId":"workflow//./input//Service.run"}}},"steps":{"input.js":{"Service.fetchData":{"stepId":"step//./input//Service.fetchData"},"Service.getConfig":{"stepId":"step//./input//Service.getConfig"}}},"classes":{"input.js":{"Service":{"classId":"class//./input//Service"}}}}*/;
// Test sync step functions in class contexts
export class Service {
    // Async static workflow method that calls sync and async steps
    static async run() {
        const config = await Service.getConfig();
        const data = await Service.fetchData('/api');
        return {
            config,
            data
        };
    }
}
// Sync function expression with var
export var syncFnExpr = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//syncFnExpr");
// Sync function expression with let
export let syncFnExprLet = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//syncFnExprLet");
Service.getConfig = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//Service.getConfig");
Service.fetchData = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//Service.fetchData");
(function(__wf_cls, __wf_id) {
    var __wf_sym = Symbol.for("workflow-class-registry"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_cls);
    Object.defineProperty(__wf_cls, "classId", {
        value: __wf_id,
        writable: false,
        enumerable: false,
        configurable: false
    });
})(Service, "class//./input//Service");
Service.run.workflowId = "workflow//./input//Service.run";
globalThis.__private_workflows.set("workflow//./input//Service.run", Service.run);
