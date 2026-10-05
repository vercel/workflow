/**__internal_workflows{"workflows":{"input.js":{"explicitFirst":{"workflowId":"workflow//./input//explicitFirst"},"explicitLast":{"workflowId":"workflow//./input//explicitLast"},"getters":{"workflowId":"workflow//./input//getters"},"standalone":{"workflowId":"workflow//./input//standalone"}}},"steps":{"input.js":{"explicitFirst/helpers/act":{"stepId":"step//./input//explicitFirst/helpers/act"},"explicitFirst/helpers/act~1":{"stepId":"step//./input//explicitFirst/helpers/act~1"},"explicitFirst/helpers/act~2":{"stepId":"step//./input//explicitFirst/helpers/act~2"},"explicitLast/helpers/act":{"stepId":"step//./input//explicitLast/helpers/act"},"explicitLast/helpers/act~1":{"stepId":"step//./input//explicitLast/helpers/act~1"},"explicitLast/helpers/act~1~1":{"stepId":"step//./input//explicitLast/helpers/act~1~1"},"getters/obj/act_1":{"stepId":"step//./input//getters/obj/act_1"},"getters/obj/act~1":{"stepId":"step//./input//getters/obj/act~1"},"keys/act-1":{"stepId":"step//./input//keys/act-1"},"keys/act_1":{"stepId":"step//./input//keys/act_1"},"keys/act~1":{"stepId":"step//./input//keys/act~1"},"standalone/helpers/act~1":{"stepId":"step//./input//standalone/helpers/act~1"}}}}*/;
var __step_getters$obj$act$1 = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//getters/obj/act~1");
var __step_getters$obj$act_1 = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//getters/obj/act_1");
// `~` is allowed in object step keys. `~N` is also the generated collision
// suffix, so names are claimed in source order with the smallest free `~N`.
// A standalone "act~1" keeps its name.
export async function standalone() {
    const helpers = {
        "act~1": globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//standalone/helpers/act~1")
    };
    return await helpers["act~1"]();
}
standalone.workflowId = "workflow//./input//standalone";
globalThis.__private_workflows.set("workflow//./input//standalone", standalone);
// Explicit "act~1" before two `act`: act~1, act, act~2.
export async function explicitFirst(op) {
    if (op === 0) {
        const helpers = {
            "act~1": globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//explicitFirst/helpers/act~1")
        };
        return await helpers["act~1"]();
    } else if (op === 1) {
        const helpers = {
            act: globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//explicitFirst/helpers/act")
        };
        return await helpers.act();
    } else {
        const helpers = {
            act: globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//explicitFirst/helpers/act~2")
        };
        return await helpers.act();
    }
}
explicitFirst.workflowId = "workflow//./input//explicitFirst";
globalThis.__private_workflows.set("workflow//./input//explicitFirst", explicitFirst);
// Explicit "act~1" after two `act`: act, act~1, act~1~1.
export async function explicitLast(op) {
    if (op === 0) {
        const helpers = {
            act: globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//explicitLast/helpers/act")
        };
        return await helpers.act();
    } else if (op === 1) {
        const helpers = {
            act: globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//explicitLast/helpers/act~1")
        };
        return await helpers.act();
    } else {
        const helpers = {
            "act~1": globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//explicitLast/helpers/act~1~1")
        };
        return await helpers["act~1"]();
    }
}
explicitLast.workflowId = "workflow//./input//explicitLast";
globalThis.__private_workflows.set("workflow//./input//explicitLast", explicitLast);
// Keys that sanitize to the same identifier still get distinct bindings.
export const keys = {
    "act~1": globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//keys/act~1"),
    act_1: globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//keys/act_1"),
    "act-1": globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//keys/act-1")
};
// Getter steps named "act~1" and act_1 get distinct proxy bindings.
export async function getters() {
    const obj = {
        get "act~1" () {
            return __step_getters$obj$act$1();
        },
        get act_1 () {
            return __step_getters$obj$act_1();
        }
    };
    return obj["act~1"] + obj.act_1;
}
getters.workflowId = "workflow//./input//getters";
globalThis.__private_workflows.set("workflow//./input//getters", getters);
