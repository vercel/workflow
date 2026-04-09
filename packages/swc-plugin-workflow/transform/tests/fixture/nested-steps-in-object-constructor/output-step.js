import { DurableAgent } from '@workflow/ai/agent';
import { gateway, tool } from 'ai';
import * as z from 'zod';
/**__internal_workflows{"workflows":{"input.js":{"test":{"workflowId":"workflow//./input//test"}}},"steps":{"input.js":{"_anonymousStep0":{"stepId":"step//./input//_anonymousStep0"},"_anonymousStep1":{"stepId":"step//./input//_anonymousStep1"}}}}*/;
var test$_anonymousStep0 = async ()=>gateway('openai/gpt-5');
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
})(test$_anonymousStep0, "step//./input//test/_anonymousStep0");
var test$_anonymousStep1 = async ({ location })=>`Weather in ${location}: Sunny, 72°F`;
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
})(test$_anonymousStep1, "step//./input//test/_anonymousStep1");
export async function test() {
    throw new Error("You attempted to execute workflow test function directly. To start a workflow, use start(test) from workflow/api");
}
test.workflowId = "workflow//./input//test";
