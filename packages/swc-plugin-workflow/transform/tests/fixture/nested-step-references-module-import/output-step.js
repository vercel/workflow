// Regression test: imports used by a step that gets hoisted out of a
// workflow body must NOT be stripped by dead-code elimination in step
// mode. Imports referenced only by the workflow body (which is replaced
// with a `throw` proxy) and truly unused imports should still be stripped.
import { db } from './db'; // used by hoisted step
import * as logger from './logger'; // used by hoisted step
/**__internal_workflows{"workflows":{"input.js":{"w":{"workflowId":"workflow//./input//w"}}},"steps":{"input.js":{"_anonymousStep0":{"stepId":"step//./input//_anonymousStep0"}}}}*/;
var _anonymousStep0 = async (input)=>{
    logger.info('querying', input.query);
    return db.query(input.query);
};
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
    Object.defineProperty(__wf_fn, "name", {
        value: "_anonymousStep0",
        configurable: true
    });
})(_anonymousStep0, "step//./input//_anonymousStep0");
async function w() {
    throw new Error("You attempted to execute workflow w function directly. To start a workflow, use start(w) from workflow/api");
}
w.workflowId = "workflow//./input//w";
