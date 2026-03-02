import { DurableAgent } from '@workflow/ai/agent';
import { tool } from 'ai';
import * as z from 'zod';
/**__internal_workflows{"workflows":{"input.js":{"test":{"workflowId":"workflow//./input//test"}}},"steps":{"input.js":{"_anonymousStep0":{"stepId":"step//./input//_anonymousStep0"},"_anonymousStep1":{"stepId":"step//./input//_anonymousStep1"}}}}*/;
export async function test() {
    const agent = new DurableAgent({
        model: globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//test/_anonymousStep0"),
        tools: {
            getWeather: tool({
                description: 'Get weather for a location',
                inputSchema: z.object({
                    location: z.string()
                }),
                execute: globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//test/_anonymousStep1")
            })
        }
    });
    await agent.stream({
        messages: [
            {
                role: 'user',
                content: 'What is the weather in San Francisco?'
            }
        ]
    });
}
test.workflowId = "workflow//./input//test";
globalThis.__private_workflows.set("workflow//./input//test", test);
