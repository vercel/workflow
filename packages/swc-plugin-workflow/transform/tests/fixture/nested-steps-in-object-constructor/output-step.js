import { registerStepFunction } from "workflow/internal/private";
import { DurableAgent } from '@workflow/ai/agent';
import { gateway, tool } from 'ai';
import * as z from 'zod';
/**__internal_workflows{"workflows":{"input.js":{"test":{"workflowId":"workflow//input.js//test"}}},"steps":{"input.js":{"_anonymousStep0":{"stepId":"step//input.js//_anonymousStep0"},"_anonymousStep1":{"stepId":"step//input.js//_anonymousStep1"}}}}*/;
async function _anonymousStep0() {
    return gateway('openai/gpt-5');
}
async function _anonymousStep1({ location }) {
    return `Weather in ${location}: Sunny, 72°F`;
}
export async function test() {
    'use workflow';
    const agent = new DurableAgent({
        model: _anonymousStep0,
        tools: {
            getWeather: tool({
                description: 'Get weather for a location',
                inputSchema: z.object({
                    location: z.string()
                }),
                execute: _anonymousStep1
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
registerStepFunction("step//input.js//_anonymousStep0", _anonymousStep0);
registerStepFunction("step//input.js//_anonymousStep1", _anonymousStep1);
