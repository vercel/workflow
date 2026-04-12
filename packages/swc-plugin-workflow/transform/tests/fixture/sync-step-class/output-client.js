/**__internal_workflows{"workflows":{"input.js":{"Service.run":{"workflowId":"workflow//./input//Service.run"}}},"steps":{"input.js":{"Service.fetchData":{"stepId":"step//./input//Service.fetchData"},"Service.getConfig":{"stepId":"step//./input//Service.getConfig"}}},"classes":{"input.js":{"Service":{"classId":"class//./input//Service"}}}}*/;
// Test sync step functions in class contexts
export class Service {
    // Sync static step method
    static getConfig() {
        return {
            timeout: 30000
        };
    }
    // Async static step method (for comparison)
    static async fetchData(url) {
        return {
            url
        };
    }
    // Async static workflow method that calls sync and async steps
    static async run() {
        throw new Error("You attempted to execute workflow Service.run function directly. To start a workflow, use start(workflow) from workflow/api");
    }
}
// Sync function expression with var
export var syncFnExpr = function process(data) {
    return data * 2;
};
syncFnExpr.stepId = "step//./input//syncFnExpr";
// Sync function expression with let
export let syncFnExprLet = function transform(input) {
    return String(input);
};
syncFnExprLet.stepId = "step//./input//syncFnExprLet";
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
