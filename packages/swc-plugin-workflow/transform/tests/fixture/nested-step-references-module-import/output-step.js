import { registerStepFunction } from "workflow/internal/private";
// Regression test for two related bugs:
//
// 1. (step mode) Imports used by a step that gets hoisted out of a
//    workflow body must NOT be stripped by dead-code elimination. The
//    workflow body is replaced with a `throw` proxy, so any import
//    referenced only by the workflow body (and not by a hoisted step)
//    should still be stripped. Truly unused imports should also be
//    stripped.
// 2. (cross-mode) The step ID generated for a nested anonymous step
//    inside a *non-exported* workflow function must agree between step
//    mode (where the step is registered) and workflow mode (where the
//    step proxy looks it up). Both must namespace the step under the
//    workflow function name (e.g. `step//./input//w/_anonymousStep0`).
import { db } from './db'; // step-mode: kept (used by hoisted step)
import { unused } from './unused'; // step-mode: stripped (truly unused)
import * as logger from './logger'; // step-mode: kept (used by hoisted step)
import { tool, z } from 'some-agent-lib'; // step-mode: stripped (only referenced by replaced workflow body); workflow-mode: kept
/**__internal_workflows{"workflows":{"input.js":{"w":{"workflowId":"workflow//./input//w"}}},"steps":{"input.js":{"_anonymousStep0":{"stepId":"step//./input//w/_anonymousStep0"}}}}*/;
var w$_anonymousStep0 = async (input)=>{
    logger.info('querying', input.query);
    return db.query(input.query);
};
async function w() {
    throw new Error("You attempted to execute workflow w function directly. To start a workflow, use start(w) from workflow/api");
}
w.workflowId = "workflow//./input//w";
registerStepFunction("step//./input//w/_anonymousStep0", w$_anonymousStep0);
