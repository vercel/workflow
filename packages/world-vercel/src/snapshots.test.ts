import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock getHttpConfig to return a localhost URL pointing at the test server.
// Set per-test via setBaseUrl().
let baseUrl = 'http://127.0.0.1:0';
vi.mock('./utils.js', () => ({
  getHttpConfig: vi.fn(() =>
    Promise.resolve({
      baseUrl,
      headers: new Headers(),
      usingProxy: false,
    })
  ),
}));

// Bypass the OIDC token fetch in getHttpConfig — handled by the mock above.

import { createSnapshotsStorage } from './snapshots.js';

interface RequestRecord {
  method: string;
  path: string;
  contentLength?: string;
  bodyBytes: number;
  bodyError?: string;
}

/**
 * HTTP test server with programmable response handlers.
 *
 * Each test installs a handler via `server.handle = (req, res, attempt) => …`.
 * The server tracks per-request body sizes and content-length so tests can
 * assert that the FULL body was received on every attempt (not 0 bytes,
 * which is the symptom of the undici fetch+RetryAgent+Buffer-body bug).
 */
class TestServer {
  server!: Server;
  url = '';
  records: RequestRecord[] = [];
  handle:
    | ((
        req: import('node:http').IncomingMessage,
        res: import('node:http').ServerResponse,
        attempt: number
      ) => void)
    | undefined;

  async start(): Promise<void> {
    this.records = [];
    this.server = createServer((req, res) => {
      const cl = req.headers['content-length'] as string | undefined;
      let bodyBytes = 0;
      const record: RequestRecord = {
        method: req.method ?? '?',
        path: req.url ?? '?',
        contentLength: cl,
        bodyBytes: 0,
      };
      req.on('data', (chunk) => {
        bodyBytes += chunk.length;
      });
      req.on('end', () => {
        record.bodyBytes = bodyBytes;
        this.records.push(record);
        const attempt = this.records.length;
        if (this.handle) {
          this.handle(req, res, attempt);
        } else {
          res.writeHead(200);
          res.end('ok');
        }
      });
      req.on('error', (err) => {
        record.bodyError = err.message;
        record.bodyBytes = bodyBytes;
        this.records.push(record);
      });
    });
    await new Promise<void>((resolve) => this.server.listen(0, resolve));
    const { port } = this.server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server.close(() => resolve());
      });
    }
  }
}

describe('snapshots storage', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = new TestServer();
    await server.start();
    baseUrl = server.url;
  });

  afterEach(async () => {
    await server.stop();
  });

  describe('save', () => {
    it('sends a single PUT with the full body when the server responds 200', async () => {
      server.handle = (_req, res) => {
        res.writeHead(200);
        res.end('ok');
      };
      const storage = createSnapshotsStorage();
      const data = new Uint8Array(1024).fill(7);
      await storage.save('wrun_test', data, {
        eventsCursor: 'eid:test',
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
      });

      expect(server.records).toHaveLength(1);
      const r = server.records[0]!;
      expect(r.method).toBe('PUT');
      expect(r.path).toBe('/v2/runs/wrun_test/snapshot');
      expect(r.bodyBytes).toBeGreaterThan(0);
      expect(r.bodyBytes).toBe(Number(r.contentLength));
    });

    it('retries on transient 503 and sends the full body on every attempt (regression: undici fetch+RetryAgent loses Buffer body on retry)', async () => {
      // First attempt: 503 (transient). Second: 200.
      // The undici fetch() + RetryAgent combo wraps Buffer bodies in a
      // one-shot ReadableStream, so the second attempt sends 0 bytes
      // and triggers UND_ERR_REQ_CONTENT_LENGTH_MISMATCH. Switching
      // the snapshot save path to undici.request() preserves the body
      // across retries.
      server.handle = (_req, res, attempt) => {
        if (attempt === 1) {
          res.writeHead(503);
          res.end('try again');
        } else {
          res.writeHead(200);
          res.end('ok');
        }
      };

      const storage = createSnapshotsStorage();
      const data = new Uint8Array(64 * 1024).fill(42);
      await storage.save('wrun_retry', data, {
        eventsCursor: null,
        createdAt: new Date('2024-01-02T00:00:00.000Z'),
      });

      expect(server.records).toHaveLength(2);
      // BOTH attempts must include the full body. If the body were lost
      // on retry, attempt 2 would have bodyBytes === 0 and the request
      // would fail with UND_ERR_REQ_CONTENT_LENGTH_MISMATCH before
      // reaching the server at all.
      for (const r of server.records) {
        expect(r.method).toBe('PUT');
        expect(r.bodyBytes).toBeGreaterThan(0);
        expect(r.bodyBytes).toBe(Number(r.contentLength));
      }
    });

    it('throws WorkflowWorldError when the server returns 4xx', async () => {
      server.handle = (_req, res) => {
        res.writeHead(400);
        res.end('bad request');
      };
      const storage = createSnapshotsStorage();
      const data = new Uint8Array(16);
      await expect(
        storage.save('wrun_bad', data, {
          eventsCursor: null,
          createdAt: new Date(),
        })
      ).rejects.toThrow(/HTTP 400/);
    });
  });
});
