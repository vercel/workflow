import { MockLanguageModelV3 } from 'ai/test';

/**
 * Creates a workflow-compatible mock model factory.
 * Wraps MockLanguageModelV3 from ai/test in an async step function,
 * following the same pattern as the real provider wrappers (anthropic, openai, etc.).
 *
 * @example
 * ```ts
 * const agent = new DurableAgent({
 *   model: mockModel({
 *     doStream: async () => ({
 *       stream: convertArrayToReadableStream([...]),
 *     }),
 *   }),
 * });
 * ```
 */
export function mockModel(
  ...args: ConstructorParameters<typeof MockLanguageModelV3>
) {
  // Note: Unlike real provider wrappers (anthropic, openai, etc.) that use 'use step',
  // the mock model factory does NOT need a step boundary because:
  // 1. The model factory runs inside doStreamStep which is already a step
  // 2. Mock constructor args contain closures (doStream) that can't be serialized
  return async () => new MockLanguageModelV3(...args);
}

export { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
