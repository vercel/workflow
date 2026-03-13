/**
 * Mock model creation helpers.
 * These build LanguageModelV3-compatible objects with hardcoded doStream logic.
 * Separated into their own file to work around an SWC plugin bug with
 * constructor closures in step functions.
 */

export type MockResponseDescriptor =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; toolName: string; input: string };

function streamFromArray<T>(values: T[]): ReadableStream<T> {
  return new ReadableStream({
    start(controller) {
      for (const v of values) controller.enqueue(v);
      controller.close();
    },
  });
}

const FINISH = {
  type: 'finish' as const,
  finishReason: { unified: 'stop' as const, raw: 'stop' },
  usage: {
    inputTokens: { total: 5, noCache: 5 },
    outputTokens: { total: 10, text: 10 },
  },
};

const TOOL_FINISH = {
  ...FINISH,
  finishReason: { unified: 'tool-calls' as const, raw: undefined },
};

function textStream(text: string) {
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
      FINISH,
    ]),
  };
}

function toolCallStream(
  toolName: string,
  input: string,
  callId: string
) {
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
      TOOL_FINISH,
    ]),
  };
}

function mockModelBase(doStreamFn: (options: any) => any): any {
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

/**
 * Creates a mock model that returns a fixed text response.
 */
export function createTextMockModel(text: string) {
  return mockModelBase(async () => textStream(text));
}

/**
 * Creates a mock model that plays through a response sequence.
 * Determines which response to return by counting assistant messages in the prompt.
 */
export function createSequenceMockModel(
  responses: MockResponseDescriptor[]
) {
  return mockModelBase(async (options: any) => {
    const assistantCount = options.prompt.filter(
      (m: any) => m.role === 'assistant'
    ).length;
    const idx = Math.min(assistantCount, responses.length - 1);
    const r = responses[idx];
    if (r.type === 'text') {
      return textStream(r.text);
    }
    return toolCallStream(r.toolName, r.input, `call-${idx + 1}`);
  });
}
