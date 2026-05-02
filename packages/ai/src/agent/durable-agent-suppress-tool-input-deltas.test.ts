import type { LanguageModelV3 } from '@ai-sdk/provider';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./stream-text-iterator.js', () => ({
  streamTextIterator: vi.fn(),
}));

const { DurableAgent } = await import('./durable-agent.js');

function createMockModel(): LanguageModelV3 {
  return {
    specificationVersion: 'v3' as const,
    provider: 'test',
    modelId: 'test-model',
    doGenerate: vi.fn(),
    doStream: vi.fn(),
    supportedUrls: {},
  };
}

describe('DurableAgent suppressToolInputDeltas', () => {
  it('passes suppressToolInputDeltas to streamTextIterator', async () => {
    const mockModel = createMockModel();
    const agent = new DurableAgent({
      model: async () => mockModel,
      tools: {},
    });
    const mockWritable = new WritableStream({
      write: vi.fn(),
      close: vi.fn(),
    });

    const { streamTextIterator } = await import('./stream-text-iterator.js');
    const mockIterator = {
      next: vi.fn().mockResolvedValueOnce({ done: true, value: [] }),
    };
    vi.mocked(streamTextIterator).mockReturnValue(mockIterator as any);

    await agent.stream({
      messages: [{ role: 'user', content: 'test' }],
      writable: mockWritable,
      suppressToolInputDeltas: true,
    });

    expect(streamTextIterator).toHaveBeenCalledWith(
      expect.objectContaining({
        suppressToolInputDeltas: true,
      })
    );
  });
});
