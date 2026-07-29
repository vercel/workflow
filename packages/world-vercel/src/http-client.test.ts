import { createSecureServer, type Http2SecureServer } from 'node:http2';
import type { AddressInfo } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { Agent } from 'undici';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createEventsDispatcher,
  createStreamDispatcher,
  DEFAULT_AGENT_OPTIONS,
  EVENTS_AGENT_OPTIONS,
  getDispatcher,
  getEventsDispatcher,
  getStreamCloseDispatcher,
  getStreamDispatcher,
  STREAM_AGENT_OPTIONS,
  STREAM_CLOSE_RETRY_OPTIONS,
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

  // Stream CLOSE is the one idempotent stream PUT: a duplicate close of a
  // completed stream early-returns, and the server's close-barrier fence is
  // an if_not_exists stamp a re-entered close resumes. The barrier protocol
  // RELIES on close retrying 5xx: transient reconciliation failures (and
  // unsafe close shapes awaiting in-flight backups) surface as retriable
  // 503s with the stream left durably closing. Without 5xx here, that 503
  // rejects writer.close() and the stream stays fenced until run expiry.
  it('retries stream close on 5xx (idempotent, and the close barrier depends on it)', () => {
    expect(STREAM_CLOSE_RETRY_OPTIONS.methods).toEqual(['PUT']);
    for (const code of [429, 500, 502, 503, 504]) {
      expect(STREAM_CLOSE_RETRY_OPTIONS.statusCodes).toContain(code);
    }
    expect(STREAM_CLOSE_RETRY_OPTIONS.retryAfter).toBe(true);
  });

  it('close uses its own shared dispatcher, distinct from the write dispatcher', () => {
    expect(getStreamCloseDispatcher()).toBe(getStreamCloseDispatcher());
    expect(getStreamCloseDispatcher()).not.toBe(getStreamDispatcher());
    const custom = {};
    expect(getStreamCloseDispatcher({ dispatcher: custom })).toBe(custom);
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
    expect(STREAM_AGENT_OPTIONS.allowH2).toBe(true);
    expect(DEFAULT_AGENT_OPTIONS.allowH2).toBe(false);
  });

  // `allowH2` alone buys nothing: undici gates in-flight requests per
  // connection on `pipelining`, so `pipelining: 1` reduces an H2 agent to H1
  // behavior (one stream per connection). These two constants are the
  // difference between multiplexing and not — see EVENTS_AGENT_OPTIONS.
  it('gives the events agent a pipelining depth that permits multiplexing', () => {
    expect(EVENTS_AGENT_OPTIONS.pipelining).toBeGreaterThan(1);
  });

  // Inverse guard: stream appends are not idempotent, so they must NOT
  // multiplex — one connection-level failure would fail (and retry) several
  // appends at once. See STREAM_AGENT_OPTIONS.
  it('keeps stream writes and the H1 default at one request per connection', () => {
    expect(STREAM_AGENT_OPTIONS.pipelining).toBe(1);
    expect(DEFAULT_AGENT_OPTIONS.pipelining).toBe(1);
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

// Negotiating h2 is not the same as using it. This measures the property the
// events agent actually exists for: concurrent POSTs sharing ONE connection as
// parallel H2 streams. It is the regression test the config-only assertions
// above cannot be — before the pipelining + interceptor fix, `allowH2` was true
// and ALPN was h2, yet 16 concurrent requests still produced 8 serialized
// requests over 8 TCP connections, exactly like the H1 agent.
describe('HTTP/2 multiplexing (events vs stream-write agents)', () => {
  const CONCURRENCY = 16;

  let server: Http2SecureServer;
  let port: number;
  let sessions: number;
  let maxConcurrentStreams: number;
  let inFlight: number;
  let receivedBodies: string[];
  let release: Array<() => void>;
  let flakyAttempts: number;

  /**
   * Holds every request open until `CONCURRENCY` of them are in flight, so peak
   * concurrency is observed rather than timed. A periodic flush (see `burst`)
   * drains whatever is waiting when that target is never reached — which is the
   * expected outcome for a non-multiplexing agent, and must fail the assertion
   * rather than hang the test.
   */
  function onArrival(path: string): Promise<void> {
    // The pool-warming request is not part of the barrier — it must complete on
    // its own so the burst starts from an established session.
    if (!path.startsWith('/req-')) return Promise.resolve();
    return new Promise<void>((resolve) => {
      inFlight++;
      maxConcurrentStreams = Math.max(maxConcurrentStreams, inFlight);
      release.push(resolve);
      if (release.length >= CONCURRENCY) {
        for (const r of release.splice(0)) r();
      }
    });
  }

  beforeAll(async () => {
    server = createSecureServer({ key: TEST_KEY, cert: TEST_CERT });
    server.on('session', (session) => {
      sessions++;
      // Agents are closed while the pool still holds idle sessions; the
      // resulting resets are expected teardown noise, not test failures.
      session.on('error', () => undefined);
    });
    server.on('sessionError', () => undefined);
    server.on('clientError', () => undefined);
    server.on('stream', (stream, headers) => {
      stream.on('error', () => undefined);
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        void (async () => {
          const path = String(headers[':path']);
          receivedBodies.push(Buffer.concat(chunks).toString());
          await onArrival(path);
          if (path.startsWith('/req-')) inFlight--;
          // `/flaky` fails once so RetryAgent re-dispatches it.
          if (path === '/flaky' && ++flakyAttempts === 1) {
            stream.respond({ ':status': 503 });
            stream.end('retry me');
            return;
          }
          stream.respond({ ':status': 200 });
          stream.end(path);
        })();
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  /** Loopback TLS escape hatch — the only deviation from production wiring. */
  const LOOPBACK = { connect: { rejectUnauthorized: false } };

  async function burst(dispatcher: unknown) {
    sessions = 0;
    maxConcurrentStreams = 0;
    inFlight = 0;
    receivedBodies = [];
    release = [];
    flakyAttempts = 0;
    // Warm the pool so connection setup isn't conflated with the stream gate:
    // a cold burst races ALPN negotiation and fans out across connections.
    await fetch(`https://127.0.0.1:${port}/warm`, {
      dispatcher,
      method: 'POST',
      body: 'warm',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- undici dispatcher type doesn't match @types/node's RequestInit
    } as any);
    const sessionsAfterWarm = sessions;
    // Repeating, not one-shot: an agent that caps in-flight requests below
    // CONCURRENCY delivers the burst in several waves, and every wave needs
    // draining or the remainder blocks forever.
    const timer = setInterval(() => {
      for (const r of release.splice(0)) r();
    }, 250);
    const bodies = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        fetch(`https://127.0.0.1:${port}/req-${i}`, {
          method: 'POST',
          body: JSON.stringify({ i }),
          dispatcher,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- undici dispatcher type doesn't match @types/node's RequestInit
        } as any).then((r) => r.text())
      )
    );
    clearInterval(timer);
    return { bodies, sessionsAfterWarm };
  }

  it('multiplexes concurrent event writes onto a single connection', async () => {
    // The real production factory — so dropping the interceptor from
    // createEventsDispatcher fails here, not just changing the constants.
    const agent = createEventsDispatcher(LOOPBACK);
    try {
      const { bodies, sessionsAfterWarm } = await burst(agent);

      expect(maxConcurrentStreams).toBe(CONCURRENCY);
      // No new TCP/TLS session beyond the warmed one — the whole point.
      expect(sessions).toBe(sessionsAfterWarm);
      // Re-buffering the body must not corrupt or cross-wire payloads.
      expect(bodies.sort()).toEqual(
        Array.from({ length: CONCURRENCY }, (_, i) => `/req-${i}`).sort()
      );
      expect(receivedBodies.filter((b) => b !== 'warm').sort()).toEqual(
        Array.from({ length: CONCURRENCY }, (_, i) =>
          JSON.stringify({ i })
        ).sort()
      );
    } finally {
      await agent.close();
    }
  });

  it('does not multiplex stream writes (non-idempotent appends stay isolated)', async () => {
    const agent = createStreamDispatcher(STREAM_RETRY_OPTIONS, LOOPBACK);
    try {
      await burst(agent);
      // Bounded by the pool size, not by CONCURRENCY: each connection carries
      // at most one append, so a reset can only ever fail one write.
      expect(maxConcurrentStreams).toBeLessThanOrEqual(
        STREAM_AGENT_OPTIONS.connections
      );
      expect(maxConcurrentStreams).toBeLessThan(CONCURRENCY);
    } finally {
      await agent.close();
    }
  });

  it('resends the full body when a re-buffered request is retried', async () => {
    // The interceptor consumes the request body to make it multiplexable, but
    // RetryAgent re-dispatches with the *original* (now exhausted) stream. If the
    // drained buffer were not reused, the retry would arrive with an empty body.
    const agent = createEventsDispatcher(LOOPBACK);
    receivedBodies = [];
    flakyAttempts = 0;
    const payload = JSON.stringify({ chunk: 'x'.repeat(64) });
    try {
      const response = await fetch(`https://127.0.0.1:${port}/flaky`, {
        method: 'PUT',
        body: payload,
        dispatcher: agent,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- undici dispatcher type doesn't match @types/node's RequestInit
      } as any);
      expect(response.status).toBe(200);
      expect(flakyAttempts).toBe(2);
      expect(receivedBodies).toEqual([payload, payload]);
    } finally {
      await agent.close();
    }
  });

  it('WORKFLOW_H2_MULTIPLEX=0 falls back to one request per connection', async () => {
    const previous = process.env.WORKFLOW_H2_MULTIPLEX;
    process.env.WORKFLOW_H2_MULTIPLEX = '0';
    // Read when the dispatcher is built, so the kill switch only takes effect
    // for agents created after it is set.
    const agent = createEventsDispatcher(LOOPBACK);
    try {
      await burst(agent);
      expect(maxConcurrentStreams).toBeLessThan(CONCURRENCY);
    } finally {
      await agent.close();
      if (previous === undefined) {
        delete process.env.WORKFLOW_H2_MULTIPLEX;
      } else {
        process.env.WORKFLOW_H2_MULTIPLEX = previous;
      }
    }
  });
});
