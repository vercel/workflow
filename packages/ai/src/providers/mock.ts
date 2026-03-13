/**
 * Mock model providers for workflow e2e testing.
 *
 * These follow the EXACT same pattern as real provider wrappers (anthropic, openai, etc.):
 * a function that captures serializable args and returns an async step function.
 * The model + doStream logic is constructed INSIDE the step body so closures
 * aren't serialized — only the serializable args are.
 */

// ============================================================================
// Stream helpers (used inside step bodies)
// ============================================================================

function streamFromArray<T>(values: T[]): ReadableStream<T> {
  return new ReadableStream({
    start(controller) {
      for (const v of values) controller.enqueue(v);
      controller.close();
    },
  });
}

const FINISH_PART = {
  type: 'finish' as const,
  finishReason: { unified: 'stop' as const, raw: 'stop' },
  usage: {
    inputTokens: { total: 5, noCache: 5 },
    outputTokens: { total: 10, text: 10 },
  },
};

const TOOL_CALL_FINISH_PART = {
  ...FINISH_PART,
  finishReason: { unified: 'tool-calls' as const, raw: undefined },
};

function makeTextStream(text: string) {
  return {
    stream: streamFromArray([
      { type: 'stream-start' as const, warnings: [] },
      {
        type: 'response-metadata' as const,
        id: 'r',
        modelId: 'mock',
        timestamp: new Date(),
      },
      { type: 'text-start' as const, id: '1' },
      { type: 'text-delta' as const, id: '1', delta: text },
      { type: 'text-end' as const, id: '1' },
      FINISH_PART,
    ]),
  };
}

function makeToolCallStream(toolName: string, input: string, callId: string) {
  return {
    stream: streamFromArray([
      { type: 'stream-start' as const, warnings: [] },
      {
        type: 'response-metadata' as const,
        id: 'r',
        modelId: 'mock',
        timestamp: new Date(),
      },
      {
        type: 'tool-call' as const,
        toolCallId: callId,
        toolName,
        input,
      },
      TOOL_CALL_FINISH_PART,
    ]),
  };
}

function makeMockModel(doStreamFn: (options: any) => any): any {
  return {
    specificationVersion: 'v3' as const,
    provider: 'mock',
    modelId: 'mock',
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error('not implemented');
    },
    doStream: doStreamFn,
  };
}

// ============================================================================
// Response descriptor types (serializable — no functions)
// ============================================================================

export type MockResponseDescriptor =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; toolName: string; input: string };

// ============================================================================
// Mock model factories (same pattern as anthropic.ts, openai.ts, etc.)
// ============================================================================

/**
 * Creates a mock model that returns a fixed text response.
 * All args are serializable strings.
 *
 * @example
 * ```ts
 * const agent = new DurableAgent({
 *   model: mockTextModel('Hello, world!'),
 * });
 * ```
 */
export function mockTextModel(text: string) {
  return async () => {
    'use step';
    return makeMockModel(async () => makeTextStream(text));
  };
}

/**
 * Creates a mock model that plays through a sequence of responses.
 * Determines which response to return based on the number of assistant
 * messages in the prompt (which grows with each agent loop iteration).
 *
 * All args are serializable (array of plain objects).
 *
 * @example
 * ```ts
 * const agent = new DurableAgent({
 *   model: mockSequenceModel([
 *     { type: 'tool-call', toolName: 'getWeather', input: '{"city":"NYC"}' },
 *     { type: 'text', text: 'The weather in NYC is sunny.' },
 *   ]),
 * });
 * ```
 */
export function mockSequenceModel(responses: MockResponseDescriptor[]) {
  return async () => {
    'use step';
    return makeMockModel(async (options: any) => {
      // Count assistant messages to determine which turn we're on.
      // Each agent loop iteration adds an assistant message to the prompt.
      const assistantCount = options.prompt.filter(
        (m: any) => m.role === 'assistant'
      ).length;
      const idx = Math.min(assistantCount, responses.length - 1);
      const response = responses[idx];

      if (response.type === 'text') {
        return makeTextStream(response.text);
      }
      return makeToolCallStream(
        response.toolName,
        response.input,
        `call-${idx + 1}`
      );
    });
  };
}

// Re-export test utilities from ai/test for unit tests (non-workflow context)
export { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
