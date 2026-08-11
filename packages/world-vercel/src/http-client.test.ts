import { createSecureServer, type Http2SecureServer } from 'node:http2';
import { type AddressInfo, connect, createServer, type Server } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { Agent, type RetryAgent } from 'undici';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createDispatcherRecycler,
  createEventsDispatcher,
  createStreamDispatcher,
  DEFAULT_AGENT_OPTIONS,
  type DispatcherRecycler,
  EVENTS_AGENT_OPTIONS,
  EVENTS_AGENT_OPTIONS_NO_H2,
  EVENTS_RECYCLE_AFTER_CONSECUTIVE_FAILURES,
  getDispatcher,
  getEventsDispatcher,
  getStreamCloseDispatcher,
  getStreamDispatcher,
  isRecyclableTransportError,
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

  // WORKFLOW_H2_MULTIPLEX=0 is the operational escape hatch for an H2 transport
  // fault, so it has to leave nothing of H2 behind: `allowH2: true` with the
  // interceptor skipped still keeps a wedged session (see
  // EVENTS_AGENT_OPTIONS_NO_H2).
  it('gives the kill switch an events agent with no HTTP/2 at all', () => {
    expect(EVENTS_AGENT_OPTIONS_NO_H2.allowH2).toBe(false);
    expect(EVENTS_AGENT_OPTIONS_NO_H2.pipelining).toBe(1);
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

  // Both receive windows have to clear undici's defaults (256 KiB stream,
  // 512 KiB connection), and the connection window has to leave room for more
  // than one stream's worth. Whichever is left at its default becomes the
  // binding constraint by itself: a single read stalls on the stream window,
  // concurrent reads stall on the shared connection window. See
  // EVENTS_AGENT_OPTIONS.
  it('raises both H2 receive windows on the events agent', () => {
    // undici's own defaults, not HTTP/2's 65535 — see undici
    // lib/dispatcher/client.js, kHTTP2InitialWindowSize / kHTTP2ConnectionWindowSize.
    const UNDICI_DEFAULT_STREAM_WINDOW = 262_144;
    const UNDICI_DEFAULT_CONNECTION_WINDOW = 524_288;

    expect(EVENTS_AGENT_OPTIONS.initialWindowSize).toBeGreaterThan(
      UNDICI_DEFAULT_STREAM_WINDOW
    );
    expect(EVENTS_AGENT_OPTIONS.connectionWindowSize).toBeGreaterThan(
      UNDICI_DEFAULT_CONNECTION_WINDOW
    );
    expect(EVENTS_AGENT_OPTIONS.connectionWindowSize).toBeGreaterThan(
      EVENTS_AGENT_OPTIONS.initialWindowSize
    );
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
});

// The transport fault this whole mechanism exists for: an HTTP/2 session whose
// TCP connection stays established while no bytes cross it. undici keeps such a
// session in service — on a stream timeout it deliberately does not destroy the
// socket, and `keepAliveTimeout` is never read on the H2 path — so every request
// the pool routes onto it times out, indefinitely.
//
// The origin here is a real h2 server behind a TCP proxy that stops forwarding
// bytes for one chosen flow, which is the closest reproduction of the production
// shape (a middlebox dropping an established mapping) that a test can be.
describe('wedged HTTP/2 session', () => {
  // Any value above the pool's connection count, so the loop cannot pass merely
  // by exhausting the poisoned connection.
  const REQUESTS_AFTER_BLACKHOLE = 12;
  // Long enough that a healthy loopback request never hits it, short enough that
  // a wedged one gives up quickly. This is the timeout that turns a black hole
  // into the UND_ERR_INFO stream timeout seen in production.
  const STREAM_TIMEOUT_MS = 300;

  let server: Http2SecureServer;
  let proxy: Server;
  let origin: string;
  let flows: number;
  let holed: Set<number>;
  let httpVersions: string[];

  /** Options that point an events agent at the loopback proxy. */
  const AGENT_OVERRIDES = {
    connect: { rejectUnauthorized: false },
    bodyTimeout: STREAM_TIMEOUT_MS,
    headersTimeout: STREAM_TIMEOUT_MS,
  };

  beforeAll(async () => {
    // allowHTTP1 so the same origin can serve the kill-switch case, which takes
    // the agent off h2 entirely.
    server = createSecureServer({
      key: TEST_KEY,
      cert: TEST_CERT,
      allowHTTP1: true,
    });
    server.on('sessionError', () => undefined);
    server.on('clientError', () => undefined);
    server.on('request', (req, res) => {
      httpVersions.push(req.httpVersion);
      res.writeHead(200);
      res.end('ok');
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const originPort = (server.address() as AddressInfo).port;

    // Byte-forwarding proxy. A flow in `holed` keeps both sockets open and
    // simply drops everything in both directions.
    proxy = createServer((client) => {
      const id = ++flows;
      const upstream = connect(originPort, '127.0.0.1');
      client.on('data', (b) => {
        if (!holed.has(id)) upstream.write(b);
      });
      upstream.on('data', (b) => {
        if (!holed.has(id)) client.write(b);
      });
      const kill = () => {
        client.destroy();
        upstream.destroy();
      };
      for (const socket of [client, upstream]) {
        socket.on('error', kill);
        socket.on('close', kill);
      }
    });
    await new Promise<void>((resolve) => {
      proxy.listen(0, '127.0.0.1', resolve);
    });
    origin = `https://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      proxy.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  beforeEach(() => {
    flows = 0;
    holed = new Set();
    httpVersions = [];
  });

  /** One request through `dispatcher`; resolves to the error, or undefined. */
  async function attempt(dispatcher: unknown): Promise<unknown> {
    try {
      const response = await fetch(`${origin}/`, {
        method: 'POST',
        body: 'x',
        dispatcher,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- undici dispatcher type doesn't match @types/node's RequestInit
      } as any);
      await response.text();
      return undefined;
    } catch (error) {
      return error;
    }
  }

  // Establishes the premise. Without the failure accounting, an events agent
  // whose session has been black-holed never recovers on its own — which is why
  // one bad flow produced a 25-minute outage rather than a blip.
  it('never recovers on its own (the failure this fixes)', async () => {
    const agent = createEventsDispatcher(AGENT_OVERRIDES);
    try {
      expect(await attempt(agent)).toBeUndefined();
      holed.add(1);

      const errors: unknown[] = [];
      for (let i = 0; i < REQUESTS_AFTER_BLACKHOLE; i++) {
        const error = await attempt(agent);
        if (error) errors.push(error);
      }
      // Every single one, and every one for the reason we key the rebuild off.
      expect(errors).toHaveLength(REQUESTS_AFTER_BLACKHOLE);
      expect(errors.every(isRecyclableTransportError)).toBe(true);
      // The pool never opened a replacement connection.
      expect(flows).toBe(1);
    } finally {
      await agent.close();
    }
  });

  it('recovers after the failure threshold, and stays recovered', async () => {
    const recycler = createDispatcherRecycler(
      () => createEventsDispatcher(AGENT_OVERRIDES),
      'test transport'
    );
    const first = recycler.get();
    try {
      recycler.note(first, await attempt(first));
      holed.add(1);

      const failures: number[] = [];
      const successes: number[] = [];
      for (let i = 0; i < REQUESTS_AFTER_BLACKHOLE; i++) {
        // Re-resolved per request, exactly as fetchV4 does — caching the
        // dispatcher across requests would pin the caller to the retired pool.
        const dispatcher = recycler.get();
        const error = await attempt(dispatcher);
        recycler.note(dispatcher, error);
        (error ? failures : successes).push(i);
      }

      // Bounded, not merely eventually-fine: the threshold is the entire cost of
      // the fault, and everything after it succeeds on the rebuilt pool.
      expect(failures).toHaveLength(EVENTS_RECYCLE_AFTER_CONSECUTIVE_FAILURES);
      expect(successes[0]).toBe(EVENTS_RECYCLE_AFTER_CONSECUTIVE_FAILURES);
      expect(recycler.get()).not.toBe(first);
      expect(flows).toBeGreaterThan(1);
    } finally {
      await recycler.get().close();
      await first.close();
    }
  });

  // The kill switch has to reach `allowH2`, not just the multiplexing
  // interceptor: with H2 still enabled the pool keeps the wedged session and the
  // switch mitigates nothing. On H1, undici destroys the socket when the request
  // times out, so the next request opens a fresh connection by itself.
  it('WORKFLOW_H2_MULTIPLEX=0 takes the events agent off h2, restoring self-healing', async () => {
    const previous = process.env.WORKFLOW_H2_MULTIPLEX;
    process.env.WORKFLOW_H2_MULTIPLEX = '0';
    // Read when the dispatcher is built, so the switch only affects agents
    // created after it is set.
    const agent = createEventsDispatcher(AGENT_OVERRIDES);
    try {
      expect(await attempt(agent)).toBeUndefined();
      expect(httpVersions).toEqual(['1.1']);
      holed.add(1);

      const errors: unknown[] = [];
      for (let i = 0; i < REQUESTS_AFTER_BLACKHOLE; i++) {
        const error = await attempt(agent);
        if (error) errors.push(error);
      }
      // A handful of connections are lost to the black hole; the point is that
      // the agent keeps making progress instead of wedging forever.
      expect(errors.length).toBeLessThan(REQUESTS_AFTER_BLACKHOLE);
      expect(flows).toBeGreaterThan(1);
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

describe('dispatcher recycling accounting', () => {
  const stub = () =>
    ({ close: async () => undefined }) as unknown as RetryAgent;
  const h2StreamTimeout = () =>
    // The shape production sees: `fetch` rejects with its own TypeError and the
    // undici error is only reachable through `cause`.
    new TypeError('fetch failed', {
      cause: Object.assign(new Error('HTTP/2: "stream timeout after 300"'), {
        code: 'UND_ERR_INFO',
      }),
    });

  function fail(recycler: DispatcherRecycler, times: number): void {
    for (let i = 0; i < times; i++) {
      recycler.note(recycler.get(), h2StreamTimeout());
    }
  }

  it('rebuilds only once the failures are consecutive', () => {
    const recycler = createDispatcherRecycler(stub, 'test');
    const first = recycler.get();

    fail(recycler, EVENTS_RECYCLE_AFTER_CONSECUTIVE_FAILURES - 1);
    expect(recycler.get()).toBe(first);
    // A delivered response means the pool works; the count starts over.
    recycler.note(recycler.get());
    fail(recycler, EVENTS_RECYCLE_AFTER_CONSECUTIVE_FAILURES - 1);
    expect(recycler.get()).toBe(first);

    recycler.note(recycler.get(), h2StreamTimeout());
    expect(recycler.get()).not.toBe(first);
  });

  // The tail of the batch that provoked a rebuild reports its failures late, on
  // the already-retired dispatcher. Counting those would recycle the replacement
  // immediately and, under sustained concurrency, every pool after it.
  it('ignores outcomes from a dispatcher it no longer owns', () => {
    const recycler = createDispatcherRecycler(stub, 'test');
    const first = recycler.get();
    fail(recycler, EVENTS_RECYCLE_AFTER_CONSECUTIVE_FAILURES);
    const second = recycler.get();
    expect(second).not.toBe(first);

    for (let i = 0; i < EVENTS_RECYCLE_AFTER_CONSECUTIVE_FAILURES; i++) {
      recycler.note(first, h2StreamTimeout());
    }
    expect(recycler.get()).toBe(second);

    // Same guard covers a caller-supplied dispatcher (APIConfig.dispatcher):
    // its failures say nothing about the shared pool.
    for (let i = 0; i < EVENTS_RECYCLE_AFTER_CONSECUTIVE_FAILURES; i++) {
      recycler.note({}, h2StreamTimeout());
    }
    expect(recycler.get()).toBe(second);
  });

  // A rebuild only helps for failures that happened on an established
  // connection. Connect/DNS/TLS errors would hit the same wall from a new pool,
  // and an abort is the caller's own doing.
  it('counts only transport failures a rebuild can fix', () => {
    expect(isRecyclableTransportError(h2StreamTimeout())).toBe(true);
    for (const code of ['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']) {
      expect(
        isRecyclableTransportError(Object.assign(new Error(code), { code }))
      ).toBe(true);
    }
    for (const code of [
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_ABORTED',
      'ENOTFOUND',
      'ECONNREFUSED',
      'CERT_HAS_EXPIRED',
    ]) {
      expect(
        isRecyclableTransportError(Object.assign(new Error(code), { code }))
      ).toBe(false);
    }
    expect(isRecyclableTransportError(new Error('nope'))).toBe(false);
    expect(isRecyclableTransportError(undefined)).toBe(false);

    const recycler = createDispatcherRecycler(stub, 'test');
    const first = recycler.get();
    for (let i = 0; i < EVENTS_RECYCLE_AFTER_CONSECUTIVE_FAILURES * 2; i++) {
      recycler.note(
        recycler.get(),
        Object.assign(new Error('aborted'), { code: 'UND_ERR_ABORTED' })
      );
    }
    expect(recycler.get()).toBe(first);
  });

  // Cycles are self-limiting: a `cause` chain that loops must not hang the walk.
  it('survives a self-referential cause chain', () => {
    const error = new Error('loop') as Error & { cause?: unknown };
    error.cause = error;
    expect(isRecyclableTransportError(error)).toBe(false);
  });
});
