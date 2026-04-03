/**__internal_workflows{"classes":{"input.js":{"Sandbox":{"classId":"class//./input//Sandbox"}}}}*/;
// Test custom serialization with CommonJS destructured require
const { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } = require("@workflow/serde");
class Sandbox {
    constructor(sandbox, routes){
        this.sandbox = sandbox;
        this.routes = routes;
    }
    static [WORKFLOW_SERIALIZE](instance) {
        return {
            sandbox: instance.sandbox,
            routes: instance.routes
        };
    }
    static [WORKFLOW_DESERIALIZE](data) {
        const instance = Object.create(Sandbox.prototype);
        instance.sandbox = data.sandbox;
        instance.routes = data.routes;
        return instance;
    }
}
exports.Sandbox = Sandbox;
(function(__wf_cls, __wf_id) {
    var __wf_sym = Symbol.for("workflow-class-registry"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_cls);
    Object.defineProperty(__wf_cls, "classId", {
        value: __wf_id,
        writable: false,
        enumerable: false,
        configurable: false
    });
})(Sandbox, "class//./input//Sandbox");
