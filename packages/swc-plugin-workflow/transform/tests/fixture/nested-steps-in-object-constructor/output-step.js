import { registerStepFunction } from "workflow/internal/private";
import { DurableAgent } from '@workflow/ai/agent';
import { gateway, tool } from 'ai';
import * as z from 'zod';
/**__internal_workflows{"workflows":{"input.js":{"test":{"workflowId":"workflow//input.js//test"}}},"steps":{"input.js":{"_anonymousStep0":{"stepId":"step//input.js//_anonymousStep0"},"_anonymousStep1":{"stepId":"step//input.js//_anonymousStep1"}}}}*/;
var test$_anonymousStep0 = async ()=>gateway('openai/gpt-5');
var test$_anonymousStep1 = async ({ location })=>`Weather in ${location}: Sunny, 72°F`;
export async function test() {
    throw new Error("You attempted to execute workflow test function directly. To start a workflow, use start(test) from workflow/api");
}
test.workflowId = "workflow//input.js//test";
registerStepFunction("step//input.js//test/_anonymousStep0", test$_anonymousStep0);
registerStepFunction("step//input.js//test/_anonymousStep1", test$_anonymousStep1);
