import OpenAI from 'openai';
import { createHook, getStepMetadata, getWorkflowMetadata } from 'workflow';

/**
 * `getStepMetadata()` is a hook that allows you to access the step's context
 * of the current workflow run.
 *
 * It is useful for accessing the context of the current workflow run, such as
 * the workflow run ID, the workflow started at, and the attempt number.
 */
async function stepWithGetMetadata() {
  'use step';
  const ctx = getStepMetadata();
  console.log('step context', ctx);

  // Mimic a retryable error 50% of the time (so that the `attempt` counter increases)
  if (Math.random() < 0.5) {
    throw new Error('Retryable error');
  }

  return ctx;
}

export async function withWorkflowMetadata() {
  'use workflow';
  const ctx = getWorkflowMetadata();
  console.log('workflow context', ctx);

  const stepCtx = await stepWithGetMetadata();

  return { workflowCtx: ctx, stepCtx };
}

async function initiateOpenAIResponse() {
  'use step';
  const openai = new OpenAI();
  const resp = await openai.responses.create({
    model: 'o3',
    input: 'Write a very long novel about otters in space.',
    background: true,
  });
  console.log('OpenAI response:', resp);
  return resp.id;
}

async function getOpenAIResponse(respId: string): Promise<string> {
  'use step';
  const openai = new OpenAI();
  const resp = await openai.responses.retrieve(respId);
  return resp.output_text;
}

/**
 * `createHook()` registers a token that can be used to resume the workflow run.
 * The token can be passed to external services as a callback URL, or used
 * for human-in-the-loop workflows by, for example, including in an email.
 *
 * The workflow run will be suspended until the hook is invoked.
 */
export async function withCreateHook() {
  'use workflow';

  // Initiate a background "Response" request to OpenAI,
  // which will invoke the hook when it's done.
  const respId = await initiateOpenAIResponse();

  // Register the hook with the token that is specific
  // to the response ID that we are interested in.
  const hook = createHook<{ type: string; data: { id: string } }>({
    token: `openai:${respId}`,
  });
  console.log('Registered hook:', hook.token);

  // Wait for the hook to be called.
  const payload = await hook;
  console.log('Received hook payload:', payload);

  if (payload.type === 'response.completed') {
    const text = await getOpenAIResponse(payload.data.id);
    console.log('OpenAI response text:', text);
  }

  console.log('Hook demo workflow completed');
}
