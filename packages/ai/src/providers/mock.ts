import { mockProvider } from './mock-function-wrapper.js';

export type MockResponseDescriptor =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; toolName: string; input: string }
  | {
      type: 'tool-call-with-reasoning';
      toolName: string;
      input: string;
      reasoning: string;
    };

/**
 * Mock model that returns a fixed text response.
 * Same 'use step' pattern as real providers (anthropic, openai, etc.).
 * Only captures `text` (string) — fully serializable across step boundary.
 */
export function mockTextModel(text: string) {
  return async () => {
    'use step';
    // Bind closure var at step body level so SWC plugin detects it
    const _text = text;
    return mockProvider({
      doStream: async () => ({
        stream: new ReadableStream({
          start(c) {
            for (const v of [
              { type: 'stream-start', warnings: [] },
              {
                type: 'response-metadata',
                id: 'r',
                modelId: 'mock',
                timestamp: new Date(),
              },
              { type: 'text-start', id: '1' },
              { type: 'text-delta', id: '1', delta: _text },
              { type: 'text-end', id: '1' },
              {
                type: 'finish',
                finishReason: { unified: 'stop', raw: 'stop' },
                usage: {
                  inputTokens: { total: 5, noCache: 5 },
                  outputTokens: { total: 10, text: 10 },
                },
              },
            ] as any[])
              c.enqueue(v);
            c.close();
          },
        }),
      }),
    });
  };
}

/**
 * Mock model that plays through a sequence of responses.
 * Determines which response to return by counting assistant messages in the prompt.
 * Only captures `responses` (array of plain objects) — fully serializable.
 */
export function mockSequenceModel(responses: MockResponseDescriptor[]) {
  return async () => {
    'use step';
    // Bind closure var at step body level so SWC plugin detects it
    const _responses = responses;
    return mockProvider({
      doStream: async (options: any) => {
        const idx = Math.min(
          options.prompt.filter((m: any) => m.role === 'assistant').length,
          _responses.length - 1
        );
        const r = _responses[idx];
        const preamble = [
          { type: 'stream-start', warnings: [] },
          {
            type: 'response-metadata',
            id: 'r',
            modelId: 'mock',
            timestamp: new Date(),
          },
        ];
        let parts: any[];
        if (r.type === 'text') {
          parts = [
            ...preamble,
            { type: 'text-start', id: '1' },
            { type: 'text-delta', id: '1', delta: r.text },
            { type: 'text-end', id: '1' },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'stop' },
              usage: {
                inputTokens: { total: 5, noCache: 5 },
                outputTokens: { total: 10, text: 10 },
              },
            },
          ];
        } else if (r.type === 'tool-call-with-reasoning') {
          parts = [
            ...preamble,
            { type: 'reasoning-start', id: 'r1' },
            { type: 'reasoning-delta', id: 'r1', delta: r.reasoning },
            { type: 'reasoning-end', id: 'r1' },
            {
              type: 'tool-call',
              toolCallId: `call-${idx + 1}`,
              toolName: r.toolName,
              input: r.input,
            },
            {
              type: 'finish',
              finishReason: { unified: 'tool-calls', raw: undefined },
              usage: {
                inputTokens: { total: 5, noCache: 5 },
                outputTokens: { total: 10, text: 10 },
              },
            },
          ];
        } else {
          parts = [
            ...preamble,
            {
              type: 'tool-call',
              toolCallId: `call-${idx + 1}`,
              toolName: r.toolName,
              input: r.input,
            },
            {
              type: 'finish',
              finishReason: { unified: 'tool-calls', raw: undefined },
              usage: {
                inputTokens: { total: 5, noCache: 5 },
                outputTokens: { total: 10, text: 10 },
              },
            },
          ];
        }
        return {
          stream: new ReadableStream({
            start(c) {
              for (const p of parts as any[]) c.enqueue(p);
              c.close();
            },
          }),
        };
      },
    });
  };
}

/**
 * Mock model that emits reasoning + tool call on the first step, then on
 * the second step inspects the prompt to verify reasoning was preserved.
 *
 * Returns text like "reasoning_found:I should use the add tool" when
 * reasoning is present in the assistant message, or "reasoning_missing"
 * when it is not. This lets e2e tests assert on the return value.
 */
export function mockReasoningToolModel(
  toolName: string,
  toolInput: string,
  reasoning: string
) {
  return async () => {
    'use step';
    const _toolName = toolName;
    const _toolInput = toolInput;
    const _reasoning = reasoning;
    return mockProvider({
      doStream: async (options: any) => {
        const assistantMsgs = options.prompt.filter(
          (m: any) => m.role === 'assistant'
        );
        const isFirstStep = assistantMsgs.length === 0;

        let parts: any[];
        const preamble = [
          { type: 'stream-start', warnings: [] },
          {
            type: 'response-metadata',
            id: 'r',
            modelId: 'mock',
            timestamp: new Date(),
          },
        ];

        if (isFirstStep) {
          // Step 0: emit reasoning + tool call
          parts = [
            ...preamble,
            { type: 'reasoning-start', id: 'r1' },
            { type: 'reasoning-delta', id: 'r1', delta: _reasoning },
            { type: 'reasoning-end', id: 'r1' },
            {
              type: 'tool-call',
              toolCallId: 'call-1',
              toolName: _toolName,
              input: _toolInput,
            },
            {
              type: 'finish',
              finishReason: { unified: 'tool-calls', raw: undefined },
              usage: {
                inputTokens: { total: 5, noCache: 5 },
                outputTokens: { total: 10, text: 10 },
              },
            },
          ];
        } else {
          // Step 1: inspect the prompt for reasoning parts in previous
          // assistant message and report findings
          const lastAssistant = assistantMsgs[assistantMsgs.length - 1];
          const reasoningParts = (lastAssistant?.content ?? []).filter(
            (p: any) => p.type === 'reasoning'
          );
          const foundText =
            reasoningParts.length > 0
              ? `reasoning_found:${reasoningParts.map((p: any) => p.text).join('')}`
              : 'reasoning_missing';

          parts = [
            ...preamble,
            { type: 'text-start', id: '1' },
            { type: 'text-delta', id: '1', delta: foundText },
            { type: 'text-end', id: '1' },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'stop' },
              usage: {
                inputTokens: { total: 5, noCache: 5 },
                outputTokens: { total: 10, text: 10 },
              },
            },
          ];
        }
        return {
          stream: new ReadableStream({
            start(c) {
              for (const p of parts as any[]) c.enqueue(p);
              c.close();
            },
          }),
        };
      },
    });
  };
}
