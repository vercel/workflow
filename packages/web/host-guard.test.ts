// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  checkRequest,
  isAllowedHost,
  normalizeAllowedHosts,
  parseAllowedHosts,
  parseHostHeader,
} from './host-guard.js';

describe('parseHostHeader', () => {
  it.each([
    ['localhost:3456', 'localhost'],
    ['LOCALHOST', 'localhost'],
    ['127.0.0.1:3456', '127.0.0.1'],
    ['[::1]:3456', '::1'],
    ['[2001:db8::20]', '2001:db8::20'],
    ['example.com.', 'example.com'],
  ])('%s -> %s', (input, expected) => {
    expect(parseHostHeader(input)).toBe(expected);
  });

  it.each([
    [''],
    [null],
    ['[::1'],
    ['[not-ip]:80'],
    ['host:abc'],
    ['[::1]x'],
  ])('rejects %s', (input) => {
    expect(parseHostHeader(input)).toBeUndefined();
  });
});

describe('isAllowedHost', () => {
  it.each([
    'localhost:3456',
    'app.localhost:3456',
    '127.0.0.1:3456',
    '[::1]:3456',
    '203.0.113.20:3456',
    '[2001:db8::20]:3456',
  ])('allows %s', (host) => {
    expect(isAllowedHost(host)).toBe(true);
  });

  it.each([
    // A name outside the allowlist, even if it resolves to this machine.
    'app.example.com:3456',
    'localhost.example.com:3456',
    '127.0.0.1.nip.io:3456',
    'my-localhost:3456',
    '',
    null,
  ])('rejects %s', (host) => {
    expect(isAllowedHost(host)).toBe(false);
  });

  it('honors exact and domain entries in allowedHosts', () => {
    const allowed = parseAllowedHosts('ui.internal, .corp.example');
    expect(isAllowedHost('ui.internal:3456', allowed)).toBe(true);
    expect(isAllowedHost('corp.example', allowed)).toBe(true);
    expect(isAllowedHost('wf.corp.example:443', allowed)).toBe(true);
    expect(isAllowedHost('other.internal', allowed)).toBe(false);
    expect(isAllowedHost('notcorp.example', allowed)).toBe(false);
  });

  it('allows every host when allowedHosts is true', () => {
    expect(parseAllowedHosts('*')).toBe(true);
    expect(parseAllowedHosts('true')).toBe(true);
    expect(isAllowedHost('anything.example', true)).toBe(true);
  });
});

describe('normalizeAllowedHosts', () => {
  it('accepts arrays, strings and true', () => {
    expect(normalizeAllowedHosts([' UI.internal ', ''])).toEqual([
      'ui.internal',
    ]);
    expect(normalizeAllowedHosts(['*'])).toBe(true);
    expect(normalizeAllowedHosts('a.example,b.example')).toEqual([
      'a.example',
      'b.example',
    ]);
    expect(normalizeAllowedHosts(true)).toBe(true);
    expect(normalizeAllowedHosts(undefined)).toEqual([]);
  });
});

describe('checkRequest', () => {
  const req = (method: string, headers: Record<string, string>) =>
    new Request('http://localhost:3456/api/rpc', { method, headers });

  it('rejects an unrecognized Host with 403', () => {
    const res = checkRequest(
      req('POST', {
        host: 'app.example.com:3456',
        origin: 'http://app.example.com:3456',
      })
    );
    expect(res?.status).toBe(403);
  });

  it('allows same-origin writes', () => {
    expect(
      checkRequest(
        req('POST', { host: 'localhost:3456', origin: 'http://localhost:3456' })
      )
    ).toBeUndefined();
  });

  it('allows writes with no Origin header (non-browser clients)', () => {
    expect(
      checkRequest(req('POST', { host: 'localhost:3456' }))
    ).toBeUndefined();
  });

  it.each([
    'https://other.example',
    'http://localhost:5173',
    'null',
  ])('rejects cross-origin writes from %s', (origin) => {
    const res = checkRequest(req('POST', { host: 'localhost:3456', origin }));
    expect(res?.status).toBe(403);
  });

  it('allows writes from an allowed origin behind a Host-rewriting proxy', () => {
    const allowed = normalizeAllowedHosts('wf.corp.example');
    expect(
      checkRequest(
        req('POST', {
          host: '127.0.0.1:3456',
          origin: 'https://wf.corp.example',
        }),
        allowed
      )
    ).toBeUndefined();
    expect(
      checkRequest(
        req('POST', {
          host: '127.0.0.1:3456',
          origin: 'https://other.example',
        }),
        allowed
      )?.status
    ).toBe(403);
  });

  it('does not apply the Origin check to safe methods', () => {
    expect(
      checkRequest(
        req('GET', {
          host: 'localhost:3456',
          origin: 'https://other.example',
        })
      )
    ).toBeUndefined();
  });
});
