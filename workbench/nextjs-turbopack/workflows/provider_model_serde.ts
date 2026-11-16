import { createOpenAI } from '@ai-sdk/openai';

/**
 * Receives an AI SDK model instance as a serialized step argument, like
 * WorkflowAgent's model steps do. Nothing here calls the provider.
 */
async function describeModel(model: {
  provider: string;
  modelId: string;
  doGenerate?: unknown;
}) {
  'use step';
  return {
    provider: model.provider,
    modelId: model.modelId,
    isModelInstance: typeof model.doGenerate === 'function',
  };
}

/**
 * The model is created only inside the workflow body, which is the
 * WorkflowAgent README shape from https://github.com/vercel/workflow/issues/4897.
 * The step-mode transform drops the `@ai-sdk/openai` import from this file,
 * and the package has no `workflow` dependency, so its classes reach the step
 * bundle only if discovery registers the provider as a serde file. Without
 * that the step fails with `Class "class//@ai-sdk/openai@…" not found`.
 */
export async function providerModelSerdeWorkflow() {
  'use workflow';
  // An explicit API key keeps the model's options serializable; the step
  // never makes a request.
  const openai = createOpenAI({ apiKey: 'not-used' });
  return await describeModel(openai.chat('gpt-4o-mini'));
}
