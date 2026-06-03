import { encode } from 'cbor-x';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveRefDescriptor } from './refs.js';
import { inspectRawWorkflowBackendResponse } from './utils.js';

vi.mock('./http-client.js', () => ({
  getDispatcher: vi.fn(),
}));

vi.mock('./utils.js', () => ({
  getHttpConfig: vi.fn().mockResolvedValue({
    baseUrl: 'https://test.example.com',
    headers: new Headers(),
  }),
  inspectRawWorkflowBackendResponse: vi.fn(),
}));

describe('resolveRefDescriptor lifecycle metadata', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('inspects raw workflow-server responses before decoding refs', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(encode({ value: 'ok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/cbor' },
      })
    );

    await expect(
      resolveRefDescriptor(
        { _type: 'RemoteRef', _ref: 's3rf:example' },
        'wrun_test'
      )
    ).resolves.toEqual({ value: 'ok' });

    expect(inspectRawWorkflowBackendResponse).toHaveBeenCalledWith(
      expect.any(Response),
      '/v2/runs/wrun_test/refs?ref=s3rf%3Aexample',
      undefined,
      'https://test.example.com/v2/runs/wrun_test/refs?ref=s3rf%3Aexample'
    );
  });
});
