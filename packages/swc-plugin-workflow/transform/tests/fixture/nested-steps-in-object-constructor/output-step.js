import { registerStepFunction } from "workflow/internal/private";
import { DurableAgent } from '@workflow/ai/agent';
import { gateway, tool } from 'ai';
import * as z from 'zod';
/**__internal_workflows{"steps":{"step//./input//_anonymousStep0":{"name":"_anonymousStep0","source":"input.js"},"step//./input//_anonymousStep1":{"name":"_anonymousStep1","source":"input.js"}},"workflows":{"workflow//./input//test":{"name":"test","source":"input.js"}}}*/;
var test$_anonymousStep0 = async ()=>gateway('openai/gpt-5');
var test$_anonymousStep1 = async ({ location })=>`Weather in ${location}: Sunny, 72°F`;
export async function test() {
    throw new Error("You attempted to execute workflow test function directly. To start a workflow, use start(test) from workflow/api");
}
test.workflowId = "workflow//./input//test";
registerStepFunction("step//./input//test/_anonymousStep0", test$_anonymousStep0);
registerStepFunction("step//./input//test/_anonymousStep1", test$_anonymousStep1);
