/**
 * Serializable Steps — Step-as-Factory pattern demo.
 *
 * Shows how to wrap a non-serializable constructor behind a step function
 * so only a serializable reference crosses the workflow boundary.
 */

// Simulates a non-serializable provider (like an AI SDK model)
function createProvider(name: string) {
  return { name, generate: (prompt: string) => `${name}:${prompt}` };
}

// Step-as-factory: outer function captures serializable args,
// inner "use step" function constructs the real object at runtime.
export function provider(name: string) {
  return async () => {
    'use step';
    return createProvider(name);
  };
}

async function runWithProvider(
  getProvider: () => Promise<{ name: string; generate: (p: string) => string }>,
  prompt: string
) {
  'use step';
  const p = await getProvider();
  return p.generate(prompt);
}

export async function serializableStepsWorkflow(
  modelName: string,
  prompt: string
) {
  'use workflow';

  const getProvider = provider(modelName);
  // getProvider is a serializable step reference, not a provider object
  const result = await runWithProvider(getProvider, prompt);
  return { modelName, result };
}
