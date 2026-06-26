import { createSecureServer, type Http2SecureServer } from 'node:http2';
import type { AddressInfo } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { Agent } from 'undici';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_AGENT_OPTIONS,
  EVENTS_AGENT_OPTIONS,
  getDispatcher,
  getEventsDispatcher,
  getStreamDispatcher,
  STREAM_RETRY_OPTIONS,
} from './http-client.js';

describe('getDispatcher', () => {
  it('returns the shared default dispatcher when none is provided', () => {
    expect(getDispatcher()).toBe(getDispatcher());
    expect(getDispatcher({})).toBe(getDispatcher());
  });

  it('returns the caller-supplied dispatcher when provided', () => {
    const custom = {};
    expect(getDispatcher({ dispatcher: custom })).toBe(custom);
  });
});

describe('getEventsDispatcher', () => {
  it('returns its own shared dispatcher, distinct from the default', () => {
    expect(getEventsDispatcher()).toBe(getEventsDispatcher());
    expect(getEventsDispatcher()).not.toBe(getDispatcher());
  });

  it('returns the caller-supplied dispatcher when provided', () => {
    const custom = {};
    expect(getEventsDispatcher({ dispatcher: custom })).toBe(custom);
  });
});

describe('getStreamDispatcher', () => {
  it('returns its own shared dispatcher, distinct from default and events', () => {
    expect(getStreamDispatcher()).toBe(getStreamDispatcher());
    expect(getStreamDispatcher()).not.toBe(getDispatcher());
    expect(getStreamDispatcher()).not.toBe(getEventsDispatcher());
  });

  it('returns the caller-supplied dispatcher when provided', () => {
    const custom = {};
    expect(getStreamDispatcher({ dispatcher: custom })).toBe(custom);
  });

  // Stream writes (PUT) append chunks and are NOT idempotent. Retrying a write
  // the server already applied would duplicate a chunk, so the retry policy is
  // deliberately narrowed: only transient connection errors and HTTP 429 (both
  // of which guarantee nothing was persisted) are retryable. A 5xx must never
  // be retried — it can mean the chunk was written but the response failed.
  it('retries stream writes only on transient errors and 429, never on 5xx', () => {
    expect(STREAM_RETRY_OPTIONS.methods).toEqual(['PUT']);
    expect(STREAM_RETRY_OPTIONS.statusCodes).toEqual([429]);
    for (const code of [500, 502, 503, 504]) {
      expect(STREAM_RETRY_OPTIONS.statusCodes).not.toContain(code);
    }
  });
});

describe('agent transport', () => {
  // Regression guards for the deliberate HTTP/2 scoping:
  //   - the events API opts into H2 (the hot read/write path), while
  //   - the default agent (queue webhook respondWith, v3, streaming) stays on
  //     H1 because H2 deadlocks the webhook mechanism.
  // Flipping either silently would regress one side or the other.
  it('enables HTTP/2 for the events API only', () => {
    expect(EVENTS_AGENT_OPTIONS.allowH2).toBe(true);
    expect(DEFAULT_AGENT_OPTIONS.allowH2).toBe(false);
  });
});

// Self-signed cert for localhost, valid 100 years. Generated with:
//   openssl req -x509 -newkey rsa:2048 -nodes -days 36500 -subj /CN=localhost
//     -addext subjectAltName=DNS:localhost,IP:127.0.0.1
// It only ever terminates a loopback test server, so the private key is inert.
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEuwIBADANBgkqhkiG9w0BAQEFAASCBKUwggShAgEAAoIBAQDH6QbH1JTD0vbo
w4ND1gDSaHfx32D6mrXwK0RgaNP0PqyjBJWb2nTA+EN0hLq16DRahjLBIIGuOfhq
YSoRdYbtUUpsV9Ywi7/oSxVIh+uNk0ASXqL9bGeUZZcdh5KkOMs5vZOj/MPIgYdn
2kn2knvtR0qqpJiqkVueb3hoSdK8bUGKR+svdGyuFmquXd/iggYaPMiYZ/EhqSoE
vTqpfCBlsDASGbsMED5LEqeyD332PkhNHnaoVofvZ96tTdk3YWe05rCfnlYSpwoi
PNvsBbeFeU1CQw8fq0ktzkEKF+SzBS39OpjZC3NyRhVFXmBVRHyc3nd+PSDwmTkm
g8OjmOIRAgMBAAECgf9LCgfaeXLMkDY0BiI/vYYFVMBdxvJSEfa1SzeassbMuggY
2DlLAVR2eTuwbkJ/OQNVpAdpM7TzLUCmYmmAX4JpTH4EMpNvNGRQ21IcgVR+SWat
/+WPlrhtxdTbTkEeO1EAHZT/wLviuuILan6ZppiYD4ZQd2g1VbO4KMwEVChCbCtX
gu+5WAXKtn1kVd7mg9k58IP/SQBPZBzhI8uYCmjvRIVKPACq2ntRabBCu40w2Pt8
5dIdFiU7FFGD7il4OHRmpopY67ZKsLjYvMbKKL6TXbev1zMgnglSt+4A5/JupGUs
Z5wxeqR5HzoV/IXdDRRqXRyNpshdnRqvrqotZr0CgYEA+o0Gosh7nwIuRGiz9j9X
m0/7Win5ozw6DgArr2joXWm/5SoVtwdSbuflaknfmolDrrlUj+lV/PPzIzkdUOC4
o9Vd+ovTSdY87xWjZUphuALbCDQ6gy9P5B+04siP27udqXg+ZF7vOCXSsEaLp7ma
B+YqE72xSQ79vD/UoGVQOm8CgYEAzEINa4d0pB2YQ2GqwVtb2gz49Lor7pB1MI2r
Fn3WogQPhltrDLFj2FpYA+uYD9Mcr9jBkFEgU3RAyutaQARfftTSZRFxYLkHalM4
ZxgC2FccPaaVe13m1ZR8nC9u0P1oAWg95W40+2epnVcCZePVF29qv4gqyljakMT0
9CtY638CgYA8Mpn/jm+1Oo7nPMjQR1PDKypW9XLXN2czafMVB/2cRAYpBz2EZiv2
HZ1PNkSVGpm6ZyjcEtHoHqyyL8zNW9DA/EjCI8o2GVU2lFpXwdFMptL9W58bWci2
JLAPNOTrhF5TE2LaNrz/HodKdwii2cMaVsCRUahAx2tLSYLKrszh3QKBgQCgwvgH
AtS1+qkFl5AqoPoZE466JvE+0am6rjXS/PX6DFIfwEHv+ooIFYsigsHq6pCwglxO
dtuHc38vdq9QpWB31Y9GhsUCiH6im59P3OEYXu9WQo9ySoTM4xJ0ZwzEJj4+pUna
ErRWjs87i+jSQtBLoqCU4No06lwUB0B4EMnqhwKBgAEcbz/0bEBLlsjtJi22kfib
V20TfIk0ReiruJgNzcAUQ9zXzWUpzCyq0eNIPGbbnzu7M1PmvuRT4UwvqOIxPKDh
sIQN52a6U6gA5KDP9rNDOkN5Bh7RSsOxY5uKqAqhPyBC+I5vTdtR5mWILf9Emc3M
jMdHLypx4TIJ2ugeZzFv
-----END PRIVATE KEY-----`;

const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIDJzCCAg+gAwIBAgIUPQi4xIRXRrIhXhrLbj/Dn3RY1SUwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MDYyMjIxNDgwOFoYDzIxMjYw
NTI5MjE0ODA4WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQDH6QbH1JTD0vbow4ND1gDSaHfx32D6mrXwK0RgaNP0
PqyjBJWb2nTA+EN0hLq16DRahjLBIIGuOfhqYSoRdYbtUUpsV9Ywi7/oSxVIh+uN
k0ASXqL9bGeUZZcdh5KkOMs5vZOj/MPIgYdn2kn2knvtR0qqpJiqkVueb3hoSdK8
bUGKR+svdGyuFmquXd/iggYaPMiYZ/EhqSoEvTqpfCBlsDASGbsMED5LEqeyD332
PkhNHnaoVofvZ96tTdk3YWe05rCfnlYSpwoiPNvsBbeFeU1CQw8fq0ktzkEKF+Sz
BS39OpjZC3NyRhVFXmBVRHyc3nd+PSDwmTkmg8OjmOIRAgMBAAGjbzBtMB0GA1Ud
DgQWBBTT1aH/RgcYEpdjuvedACycPwYPtDAfBgNVHSMEGDAWgBTT1aH/RgcYEpdj
uvedACycPwYPtDAPBgNVHRMBAf8EBTADAQH/MBoGA1UdEQQTMBGCCWxvY2FsaG9z
dIcEfwAAATANBgkqhkiG9w0BAQsFAAOCAQEAHpbHKTelmRfi5UV3Nox79ttqu2GM
CIHoTJBD5hdjcE31wbHt/fK76dWknGR0wG5v5vC071lAWliQoYRlJfloy536XOXc
zPvVs6UqXfPji6kWyHA74qM1zKjLvoPQhWuDJqepb6CYhM1iX3tV4LHWXCDASNuV
wIaFqUOx2vU/DLcH47+VEnEtrmodMvownUojvO+eZ1aODpPyYQg4Iqt5StSLURFz
JSsW5YzWatjMPka0HLgfbf7gv0+QFF7vGd9TqUO7ZD7NuPDuKuT5BMa6XxoQYkIO
TTVKDw9WMB6CyIX5kV0cOG/S8OO+1l3ZPaogkzj0P5OnJaYPvpp2kpGrlQ==
-----END CERTIFICATE-----`;

// Proves the exact mechanism the v4 events path relies on: a request issued
// through the *global* `fetch` with an `allowH2` undici dispatcher actually
// negotiates HTTP/2 over ALPN. `fetchV4` (events-v4.ts) routes through global
// `fetch` for observability instrumentation rather than `undici.request`, so we
// verify h2 survives that route. The server only speaks h2 (allowHTTP1 left at
// its default of false), so a client that fell back to HTTP/1.1 would fail to
// connect instead of silently passing.
describe('HTTP/2 over global fetch with an undici dispatcher', () => {
  let server: Http2SecureServer;
  let port: number;
  let negotiatedAlpn: string | false | null | undefined;
  const agent = new Agent({
    allowH2: true,
    connect: { rejectUnauthorized: false },
  });

  beforeAll(async () => {
    server = createSecureServer({ key: TEST_KEY, cert: TEST_CERT });
    // 'stream' only fires for HTTP/2 sessions.
    server.on('stream', (stream) => {
      negotiatedAlpn = (stream.session?.socket as TLSSocket | undefined)
        ?.alpnProtocol;
      stream.respond({ ':status': 200 });
      stream.end('ok');
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await agent.close();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it('negotiates h2 (global fetch honors the dispatcher)', async () => {
    const res = await fetch(`https://127.0.0.1:${port}/`, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- undici dispatcher type doesn't match @types/node's RequestInit
      dispatcher: agent,
    } as any);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
    expect(negotiatedAlpn).toBe('h2');
  });
});
