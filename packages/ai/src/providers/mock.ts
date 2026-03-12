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
  return async () => {
    'use step';
    return new MockLanguageModelV3(...args);
  };
}

export { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
