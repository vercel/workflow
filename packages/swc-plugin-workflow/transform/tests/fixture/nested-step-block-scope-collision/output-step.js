// Steps with the same local name in different block scopes are distinct
// functions and must get distinct hoisted bindings and step IDs.
// Unrelated names elsewhere in the file don't affect generated suffixes.
/**__internal_workflows{"workflows":{"input.js":{"collisionWorkflow":{"workflowId":"workflow//./input//collisionWorkflow"},"fnDeclWorkflow":{"workflowId":"workflow//./input//fnDeclWorkflow"},"objectWorkflow":{"workflowId":"workflow//./input//objectWorkflow"},"reservedSuffixWorkflow":{"workflowId":"workflow//./input//reservedSuffixWorkflow"},"suffixWorkflow":{"workflowId":"workflow//./input//suffixWorkflow"}}},"steps":{"input.js":{"collisionWorkflow/act":{"stepId":"step//./input//collisionWorkflow/act"},"collisionWorkflow/act~1":{"stepId":"step//./input//collisionWorkflow/act~1"},"fnDeclWorkflow/act":{"stepId":"step//./input//fnDeclWorkflow/act"},"fnDeclWorkflow/act~1":{"stepId":"step//./input//fnDeclWorkflow/act~1"},"objectWorkflow/helpers/act":{"stepId":"step//./input//objectWorkflow/helpers/act"},"objectWorkflow/helpers/act~1":{"stepId":"step//./input//objectWorkflow/helpers/act~1"},"reservedSuffixWorkflow/act":{"stepId":"step//./input//reservedSuffixWorkflow/act"},"reservedSuffixWorkflow/act$1":{"stepId":"step//./input//reservedSuffixWorkflow/act$1"},"reservedSuffixWorkflow/act~1":{"stepId":"step//./input//reservedSuffixWorkflow/act~1"},"suffixWorkflow/act":{"stepId":"step//./input//suffixWorkflow/act"},"suffixWorkflow/act$1":{"stepId":"step//./input//suffixWorkflow/act$1"},"suffixWorkflow/act~1":{"stepId":"step//./input//suffixWorkflow/act~1"}}}}*/;
var collisionWorkflow$act = async (id)=>`validated:${id}`;
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "collisionWorkflow$act",
        configurable: true
    });
})(collisionWorkflow$act, "step//./input//collisionWorkflow/act");
var collisionWorkflow$act$1 = async (id)=>`approved:${id}`;
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "collisionWorkflow$act$1",
        configurable: true
    });
})(collisionWorkflow$act$1, "step//./input//collisionWorkflow/act~1");
async function fnDeclWorkflow$act() {
    return "a";
}
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "fnDeclWorkflow$act",
        configurable: true
    });
})(fnDeclWorkflow$act, "step//./input//fnDeclWorkflow/act");
async function fnDeclWorkflow$act$1() {
    return "b";
}
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "fnDeclWorkflow$act$1",
        configurable: true
    });
})(fnDeclWorkflow$act$1, "step//./input//fnDeclWorkflow/act~1");
var suffixWorkflow$act = async ()=>"a";
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "suffixWorkflow$act",
        configurable: true
    });
})(suffixWorkflow$act, "step//./input//suffixWorkflow/act");
var suffixWorkflow$act$1 = async ()=>"b";
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "suffixWorkflow$act$1",
        configurable: true
    });
})(suffixWorkflow$act$1, "step//./input//suffixWorkflow/act$1");
var suffixWorkflow$act$1$1 = async ()=>"c";
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "suffixWorkflow$act$1$1",
        configurable: true
    });
})(suffixWorkflow$act$1$1, "step//./input//suffixWorkflow/act~1");
var reservedSuffixWorkflow$act = async ()=>"a";
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "reservedSuffixWorkflow$act",
        configurable: true
    });
})(reservedSuffixWorkflow$act, "step//./input//reservedSuffixWorkflow/act");
var reservedSuffixWorkflow$act$1 = async ()=>"b";
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "reservedSuffixWorkflow$act$1",
        configurable: true
    });
})(reservedSuffixWorkflow$act$1, "step//./input//reservedSuffixWorkflow/act~1");
var reservedSuffixWorkflow$act$1$1 = async ()=>"privileged";
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "reservedSuffixWorkflow$act$1$1",
        configurable: true
    });
})(reservedSuffixWorkflow$act$1$1, "step//./input//reservedSuffixWorkflow/act$1");
var objectWorkflow$helpers$act = async function() {
    return "a";
};
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "objectWorkflow$helpers$act",
        configurable: true
    });
})(objectWorkflow$helpers$act, "step//./input//objectWorkflow/helpers/act");
var objectWorkflow$helpers$act$1 = async function() {
    return "b";
};
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "objectWorkflow$helpers$act$1",
        configurable: true
    });
})(objectWorkflow$helpers$act$1, "step//./input//objectWorkflow/helpers/act~1");
export async function collisionWorkflow(operation, requestId) {
    throw new Error("You attempted to execute workflow collisionWorkflow function directly. To start a workflow, use start(collisionWorkflow) from workflow/api");
}
collisionWorkflow.workflowId = "workflow//./input//collisionWorkflow";
export async function fnDeclWorkflow(operation) {
    throw new Error("You attempted to execute workflow fnDeclWorkflow function directly. To start a workflow, use start(fnDeclWorkflow) from workflow/api");
}
fnDeclWorkflow.workflowId = "workflow//./input//fnDeclWorkflow";
export async function objectWorkflow(operation) {
    throw new Error("You attempted to execute workflow objectWorkflow function directly. To start a workflow, use start(objectWorkflow) from workflow/api");
}
objectWorkflow.workflowId = "workflow//./input//objectWorkflow";
// A user-declared step named `act$1` doesn't affect the generated `act~1`
// step ID; only the hoisted bindings are renamed to stay unique.
export async function suffixWorkflow(operation) {
    throw new Error("You attempted to execute workflow suffixWorkflow function directly. To start a workflow, use start(suffixWorkflow) from workflow/api");
}
suffixWorkflow.workflowId = "workflow//./input//suffixWorkflow";
// An explicitly named step declared after the duplicates keeps its own name
// and ID regardless of source order.
export async function reservedSuffixWorkflow(operation) {
    throw new Error("You attempted to execute workflow reservedSuffixWorkflow function directly. To start a workflow, use start(reservedSuffixWorkflow) from workflow/api");
}
reservedSuffixWorkflow.workflowId = "workflow//./input//reservedSuffixWorkflow";
