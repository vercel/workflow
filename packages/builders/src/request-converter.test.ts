import { describe, expect, it } from 'vitest';

import {
  NORMALIZE_REQUEST_CODE,
  STREAMING_NORMALIZE_REQUEST_CODE,
} from './request-converter.js';

// Evaluate the generated code snippets the same way the framework builders
// inline them into generated route files.
const normalizeRequest: (request: Request) => Promise<Request> = new Function(
  `${NORMALIZE_REQUEST_CODE}; return normalizeRequest;`
)();

const normalizeRequestStreaming: (request: Request) => Request = new Function(
  `${STREAMING_NORMALIZE_REQUEST_CODE}; return normalizeRequestStreaming;`
)();

function createTrackedRequest(chunks: Uint8Array[]) {
  let pulled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled = true;
      const chunk = chunks.shift();
      if (chunk) {
        controller.enqueue(chunk);
      } else {
        controller.close();
      }
    },
  });
  const request = new Request('http://localhost/webhook/token', {
    method: 'POST',
    headers: { 'x-test': 'yes' },
    body: stream,
    // duplex is required by undici for stream bodies
    duplex: 'half',
  } as RequestInit);
  return { request, wasPulled: () => pulled };
}

describe('normalizeRequest', () => {
  it('preserves method, url, headers, and body', async () => {
    const { request } = createTrackedRequest([
      new TextEncoder().encode('hello'),
    ]);
    const normalized = await normalizeRequest(request);
    expect(normalized.method).toBe('POST');
    expect(normalized.url).toBe('http://localhost/webhook/token');
    expect(normalized.headers.get('x-test')).toBe('yes');
    expect(await normalized.text()).toBe('hello');
  });
});

describe('normalizeRequestStreaming', () => {
  it('does not consume the request body before it is read (pre-auth paths must fail fast)', () => {
    const { request, wasPulled } = createTrackedRequest([
      new TextEncoder().encode('hello'),
    ]);
    const normalized = normalizeRequestStreaming(request);
    // The webhook wrapper must be able to reject invalid tokens without
    // buffering the request body first.
    expect(wasPulled()).toBe(false);
    expect(normalized.bodyUsed).toBe(false);
  });

  it('preserves method, url, headers, and body when the body is read', async () => {
    const { request, wasPulled } = createTrackedRequest([
      new TextEncoder().encode('hello '),
      new TextEncoder().encode('world'),
    ]);
    const normalized = normalizeRequestStreaming(request);
    expect(normalized.method).toBe('POST');
    expect(normalized.url).toBe('http://localhost/webhook/token');
    expect(normalized.headers.get('x-test')).toBe('yes');
    expect(await normalized.text()).toBe('hello world');
    expect(wasPulled()).toBe(true);
  });

  it('produces a bodyless request for GET requests', () => {
    const request = new Request('http://localhost/webhook/token', {
      method: 'GET',
      headers: { 'x-test': 'yes' },
    });
    const normalized = normalizeRequestStreaming(request);
    expect(normalized.method).toBe('GET');
    expect(normalized.body).toBeNull();
    expect(normalized.headers.get('x-test')).toBe('yes');
  });

  it('handles POST requests without a body', async () => {
    const request = new Request('http://localhost/webhook/token', {
      method: 'POST',
    });
    const normalized = normalizeRequestStreaming(request);
    expect(normalized.method).toBe('POST');
    expect(await normalized.text()).toBe('');
  });
});
