import {
  createTextMockModel,
  createSequenceMockModel,
} from './mock-create.js';

export type { MockResponseDescriptor } from './mock-create.js';

/**
 * Mock model that returns a fixed text response.
 * Same 'use step' pattern as real providers (anthropic, openai, etc.).
 * Only captures `text` (a string) — fully serializable.
 */
export function mockTextModel(text: string) {
  return async () => {
    'use step';
    return createTextMockModel(text);
  };
}

/**
 * Mock model that plays through a sequence of responses.
 * Same 'use step' pattern as real providers.
 * Only captures `responses` (array of plain objects) — fully serializable.
 */
export function mockSequenceModel(
  responses: Parameters<typeof createSequenceMockModel>[0]
) {
  return async () => {
    'use step';
    return createSequenceMockModel(responses);
  };
}

export { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
