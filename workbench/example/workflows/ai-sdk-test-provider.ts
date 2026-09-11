import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type MockResponseDescriptor =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; toolName: string; input: string }
  | {
      type: 'provider-tool-call';
      toolName: string;
      input: string;
      result: Exclude<JsonValue, null>;
    };

type MockStreamOptions = Parameters<MockLanguageModelV4['doStream']>[0];
type MockStreamResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>;
type MockStreamPart = MockStreamResult extends {
  stream: ReadableStream<infer Part>;
}
  ? Part
  : never;

const usage = {
  inputTokens: {
    total: 5,
    noCache: 5,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 10, text: 10, reasoning: undefined },
};

class SerializableMockLanguageModel extends MockLanguageModelV4 {
  static [Symbol.for('workflow-serialize')](
    model: SerializableMockLanguageModel
  ) {
    return { responses: model.responses };
  }

  static [Symbol.for('workflow-deserialize')](options: {
    responses: MockResponseDescriptor[];
  }) {
    return new SerializableMockLanguageModel(options.responses);
  }

  constructor(private readonly responses: MockResponseDescriptor[]) {
    super({
      provider: 'workflow-test',
      modelId: 'workflow-test-model',
      doStream: async (options: MockStreamOptions) => {
        const responseIndex = Math.min(
          options.prompt.filter((message) => message.role === 'assistant')
            .length,
          responses.length - 1
        );
        const response = responses[responseIndex];

        const toolCallId = `call-${responseIndex + 1}`;
        const prefix: MockStreamPart[] = [
          { type: 'stream-start', warnings: [] },
          {
            type: 'response-metadata',
            id: `response-${responseIndex}`,
            modelId: 'workflow-test-model',
            timestamp: new Date('2026-08-31T00:00:00.000Z'),
          },
        ];
        const streamParts: MockStreamPart[] =
          response.type === 'text'
            ? [
                ...prefix,
                { type: 'text-start', id: `text-${responseIndex}` },
                {
                  type: 'text-delta',
                  id: `text-${responseIndex}`,
                  delta: response.text,
                },
                { type: 'text-end', id: `text-${responseIndex}` },
                {
                  type: 'finish',
                  finishReason: { unified: 'stop', raw: 'stop' },
                  usage,
                },
              ]
            : response.type === 'provider-tool-call'
              ? [
                  ...prefix,
                  {
                    type: 'tool-call',
                    toolCallId,
                    toolName: response.toolName,
                    input: response.input,
                    providerExecuted: true,
                  },
                  {
                    type: 'tool-result',
                    toolCallId,
                    toolName: response.toolName,
                    result: response.result,
                  },
                  {
                    type: 'finish',
                    finishReason: { unified: 'tool-calls', raw: undefined },
                    usage,
                  },
                ]
              : [
                  ...prefix,
                  {
                    type: 'tool-call',
                    toolCallId,
                    toolName: response.toolName,
                    input: response.input,
                  },
                  {
                    type: 'finish',
                    finishReason: { unified: 'tool-calls', raw: undefined },
                    usage,
                  },
                ];

        return { stream: convertArrayToReadableStream(streamParts) };
      },
    });
  }
}

export function mockTextModel(text: string): MockLanguageModelV4 {
  return mockSequenceModel([{ type: 'text', text }]);
}

export function mockSequenceModel(
  responses: MockResponseDescriptor[]
): MockLanguageModelV4 {
  if (responses.length === 0) {
    throw new Error('At least one mock response is required');
  }

  return new SerializableMockLanguageModel(responses);
}
