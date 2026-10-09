import { describe, expect, it } from 'vitest';
import { formatErrorCauseChain } from './types.js';

describe('formatErrorCauseChain', () => {
  it.each([
    'cause',
    'name',
    'message',
    'code',
    'errors',
  ])('tolerates a throwing %s getter in the cause chain', (property) => {
    const cause = new Error('inner');
    Object.defineProperty(cause, property, {
      get() {
        throw new Error('getter failed');
      },
    });

    expect(formatErrorCauseChain(new Error('outer', { cause }))).toContain(
      '[unavailable cause]'
    );
  });

  it('preserves readable links before an inaccessible cause', () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    const middle = new Error('middle', { cause: proxy });

    expect(formatErrorCauseChain(new Error('outer', { cause: middle }))).toBe(
      'Error: middle\n[unavailable cause]'
    );
  });

  it('tolerates a throwing getter on the outer cause', () => {
    const error = new Error('outer');
    Object.defineProperty(error, 'cause', {
      get() {
        throw new Error('getter failed');
      },
    });

    expect(formatErrorCauseChain(error)).toBe('[unavailable cause]');
  });

  it('returns an empty string when there is no cause', () => {
    expect(formatErrorCauseChain(new Error('boom'))).toBe('');
    expect(formatErrorCauseChain('not an error')).toBe('');
    expect(formatErrorCauseChain(undefined)).toBe('');
  });

  it('renders the wrapped reason a `fetch failed` hides', () => {
    // The whole point: the outer error says nothing, the cause says
    // everything. The outer link is skipped — the log already prints it.
    const cause = Object.assign(new Error('other side closed'), {
      name: 'SocketError',
      code: 'UND_ERR_SOCKET',
    });
    const wrapper = new TypeError('fetch failed', { cause });

    expect(formatErrorCauseChain(wrapper)).toBe(
      'SocketError: other side closed (UND_ERR_SOCKET)'
    );
  });

  it('renders each link of a multi-level chain, outermost first', () => {
    const inner = Object.assign(
      new Error('getaddrinfo ENOTFOUND ai-gateway.vercel.sh'),
      { code: 'ENOTFOUND' }
    );
    const wrapper = new Error('POST /v4/… transport failure (ENOTFOUND)', {
      cause: new TypeError('fetch failed', { cause: inner }),
    });

    expect(formatErrorCauseChain(wrapper)).toBe(
      [
        'TypeError: fetch failed',
        // The code is already in the message, so it is not repeated.
        'Error: getaddrinfo ENOTFOUND ai-gateway.vercel.sh',
      ].join('\n')
    );
  });

  it('summarizes the attempts an AggregateError collects', () => {
    // A happy-eyeballs connect reports every address it tried on `errors`
    // and leaves the AggregateError itself blank.
    const aggregate = new AggregateError(
      [
        Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:443'), {
          code: 'ECONNREFUSED',
        }),
        Object.assign(new Error('connect ECONNREFUSED [::1]:443'), {
          code: 'ECONNREFUSED',
        }),
      ],
      ''
    );

    expect(
      formatErrorCauseChain(new TypeError('fetch failed', { cause: aggregate }))
    ).toBe(
      [
        'AggregateError',
        'Error: connect ECONNREFUSED 10.0.0.1:443',
        'Error: connect ECONNREFUSED [::1]:443',
      ].join('\n')
    );
  });

  it('caps a long chain', () => {
    let error = new Error('innermost');
    for (let i = 0; i < 8; i++) {
      error = new Error(`level ${i}`, { cause: error });
    }

    const lines = formatErrorCauseChain(error).split('\n');
    expect(lines).toHaveLength(5);
    expect(lines.at(-1)).toBe('…');
  });

  it('stops on a cyclic chain', () => {
    const inner = new Error('inner') as Error & { cause?: unknown };
    const outer = new Error('outer', { cause: inner });
    inner.cause = outer;

    expect(formatErrorCauseChain(outer)).toBe(
      ['Error: inner', 'Error: outer'].join('\n')
    );
  });

  it('renders a non-error cause', () => {
    expect(
      formatErrorCauseChain(new Error('boom', { cause: 'a string' }))
    ).toBe('a string');
  });
});
