import { describe, expect, it } from 'vitest';
import { serializeGraphileMeta } from './queue.js';

describe('serializeGraphileMeta', () => {
  it('expands the non-enumerable Error fields JSON.stringify drops', () => {
    const error = new Error('delivery failed');
    expect(JSON.parse(JSON.stringify({ error }))).toEqual({ error: {} });

    const meta = JSON.parse(serializeGraphileMeta({ error, jobId: '7' }));
    expect(meta).toMatchObject({
      jobId: '7',
      error: {
        name: 'Error',
        message: 'delivery failed',
        stack: expect.stringContaining('Error: delivery failed'),
      },
    });
    expect(meta.error).not.toHaveProperty('cause');
  });

  it('keeps enumerable diagnostics and recurses through cause and AggregateError', () => {
    const socket = Object.assign(new Error('other side closed'), {
      code: 'UND_ERR_SOCKET',
    });
    const fetchFailed = new TypeError('fetch failed', { cause: socket });
    const aggregate = new AggregateError([fetchFailed], 'all attempts failed');

    const meta = JSON.parse(serializeGraphileMeta({ error: aggregate }));
    expect(meta.error).toMatchObject({
      name: 'AggregateError',
      message: 'all attempts failed',
      errors: [
        {
          name: 'TypeError',
          message: 'fetch failed',
          cause: {
            name: 'Error',
            message: 'other side closed',
            code: 'UND_ERR_SOCKET',
            stack: expect.stringContaining('other side closed'),
          },
        },
      ],
    });
  });

  it('does not throw on a cyclic cause chain', () => {
    const outer = new Error('outer');
    const inner = new Error('inner', { cause: outer });
    outer.cause = inner;

    const meta = JSON.parse(serializeGraphileMeta({ error: outer }));
    expect(meta.error).toMatchObject({
      message: 'outer',
      cause: {
        message: 'inner',
        cause: { name: 'Error', message: 'outer', repeated: true },
      },
    });
  });
});
