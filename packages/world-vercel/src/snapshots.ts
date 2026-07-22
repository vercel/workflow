import { WorkflowWorldError } from '@workflow/errors';
import type { SnapshotMetadata, Storage } from '@workflow/world';
import { request as undiciRequest } from 'undici';
import { getDispatcher } from './http-client.js';
import { injectTraceContextIntoHeaders } from './telemetry.js';
import { type APIConfig, getHttpConfig } from './utils.js';

/**
 * Convert a Web `Headers` object into a plain record for undici's
 * lower-level `request()` API. Headers in undici-request take
 * `Record<string, string | string[]>`, not the Headers object.
 */
function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [key, value] of headers) {
    record[key] = value;
  }
  return record;
}

/**
 * Create snapshot storage backed by the workflow-server API.
 *
 * Compression and encryption are handled by `@workflow/core`'s
 * snapshot entrypoint (`compress(snapshot) → encrypt → save`). This
 * world layer transports the bytes opaquely — it does not compress
 * (encryption produces ciphertext that doesn't compress) and it does
 * not encrypt.
 *
 * Snapshot endpoints use raw binary transfer:
 *   - PUT  /v2/runs/:runId/snapshot — binary body, metadata in headers
 *   - GET  /v2/runs/:runId/snapshot — binary response, metadata in headers
 *   - DELETE /v2/runs/:runId/snapshot — no body
 */
export function createSnapshotsStorage(
  config?: APIConfig
): Storage['snapshots'] {
  return {
    async save(
      runId: string,
      data: Uint8Array,
      metadata: SnapshotMetadata
    ): Promise<void> {
      const t0 = performance.now();
      const { baseUrl, headers } = await getHttpConfig(config);
      const url = `${baseUrl}/v2/runs/${encodeURIComponent(runId)}/snapshot`;

      // Bytes arrive opaquely from the core's
      // `compress → encrypt` pipeline. Forward verbatim.
      headers.set('Content-Type', 'application/octet-stream');
      headers.set('X-Snapshot-Events-Cursor', metadata.eventsCursor ?? '');
      headers.set('X-Snapshot-Created-At', metadata.createdAt.toISOString());
      // Explicit W3C trace-context injection: this path routes around
      // `makeRequest` (raw undici for Buffer-body retry correctness), so
      // ambient auto-instrumentation does not reliably hook it. Required
      // for workflow-server spans to join the caller's trace — see
      // telemetry.ts and trace-propagation.test.ts.
      await injectTraceContextIntoHeaders(headers);

      // Use undici.request() rather than the global fetch() because
      // fetch() + RetryAgent is broken for Buffer/Uint8Array bodies:
      // fetch wraps the body in a one-shot ReadableStream (per the
      // WHATWG fetch spec), so when the RetryAgent retries (on 5xx or
      // network errors), the second attempt sends 0 bytes and undici
      // throws `UND_ERR_REQ_CONTENT_LENGTH_MISMATCH`. The lower-level
      // `request()` API hands the Buffer to the connection layer
      // directly, which can be replayed on retry.
      //
      // Upstream context: nodejs/undici#3288 (filed May 2024) reported
      // this exact failure. The "fix" in nodejs/undici#3294 made
      // RetryAgent skip stateful bodies rather than rewind them, and
      // the maintainers explicitly recommended switching to
      // `undici.request()` for any retried request with a body. Don't
      // simplify this back to `fetch()` without first verifying that
      // upstream now copies Buffers across retries.
      //
      // Snapshot bodies are 5-15 MB so the bug fires constantly under
      // network turbulence; a single failed save poisons the run
      // (handler returns 500 -> queue retries handler -> save fails
      // again -> 5xx loop until the run TTL).
      const putStart = performance.now();
      const response = await undiciRequest(url, {
        method: 'PUT',
        body: data,
        headers: headersToRecord(headers),
        dispatcher: getDispatcher(config) as never,
      });
      const putDurationMs = Math.round(performance.now() - putStart);

      if (response.statusCode < 200 || response.statusCode >= 300) {
        const text = await response.body.text().catch(() => '');
        throw new WorkflowWorldError(
          `PUT /v2/runs/${runId}/snapshot -> HTTP ${response.statusCode}: ${text}`,
          { url, status: response.statusCode }
        );
      }

      // Consume the response body to release the connection
      await response.body.text();

      // Diagnostic: actual on-the-wire snapshot bytes and the HTTP-PUT
      // cost, grep-able by runId alongside @workflow/core's QUICKJS_VM
      // diagnostics.
      console.debug('[Workflow] WORLD_SNAPSHOT_DIAG', {
        op: 'save',
        runId,
        // Bytes received from the core — already compressed and
        // encrypted upstream. The world transports them opaquely.
        wireBytes: data.byteLength,
        putDurationMs,
        totalDurationMs: Math.round(performance.now() - t0),
      });
    },

    async load(
      runId: string
    ): Promise<{ data: Uint8Array; metadata: SnapshotMetadata } | null> {
      const t0 = performance.now();
      const { baseUrl, headers } = await getHttpConfig(config);
      const url = `${baseUrl}/v2/runs/${encodeURIComponent(runId)}/snapshot`;

      headers.set('Accept', 'application/octet-stream');
      await injectTraceContextIntoHeaders(headers);

      const getStart = performance.now();
      const response = await fetch(url, {
        method: 'GET',
        headers,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- undici dispatcher
        dispatcher: getDispatcher(config),
      } as any);
      const getDurationMs = Math.round(performance.now() - getStart);

      if (response.status === 404) {
        // Consume the response body to release the connection
        await response.text().catch(() => {});
        // Diagnostic: emit the not-found case so we can correlate the
        // skip-load fast-path in core with whatever the world saw.
        console.debug('[Workflow] WORLD_SNAPSHOT_DIAG', {
          op: 'load',
          runId,
          outcome: 'not_found',
          getDurationMs,
          totalDurationMs: Math.round(performance.now() - t0),
        });
        return null;
      }

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new WorkflowWorldError(
          `GET /v2/runs/${runId}/snapshot -> HTTP ${response.status}: ${text}`,
          { url, status: response.status }
        );
      }

      const buffer = await response.arrayBuffer();
      const data = new Uint8Array(buffer);

      const eventsCursor =
        response.headers.get('X-Snapshot-Events-Cursor') || null;
      const createdAtStr = response.headers.get('X-Snapshot-Created-At');
      const createdAt = createdAtStr ? new Date(createdAtStr) : new Date();

      // CI-visible diagnostic: actual on-the-wire snapshot bytes and
      // HTTP-GET cost. Same format/pairing as the save side above so
      // the entire snapshot save/load lifecycle is grep-able from
      // Vercel function logs by runId.
      console.debug('[Workflow] WORLD_SNAPSHOT_DIAG', {
        op: 'load',
        runId,
        outcome: 'ok',
        // Bytes returned by the workflow-server (already
        // compressed+encrypted by core; this layer transports them
        // opaquely).
        wireBytes: data.byteLength,
        getDurationMs,
        totalDurationMs: Math.round(performance.now() - t0),
      });

      return {
        data,
        metadata: {
          eventsCursor: eventsCursor || null,
          createdAt,
        },
      };
    },

    async delete(runId: string): Promise<void> {
      const { baseUrl, headers } = await getHttpConfig(config);
      const url = `${baseUrl}/v2/runs/${encodeURIComponent(runId)}/snapshot`;
      await injectTraceContextIntoHeaders(headers);

      const response = await fetch(url, {
        method: 'DELETE',
        headers,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- undici dispatcher
        dispatcher: getDispatcher(config),
      } as any);

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new WorkflowWorldError(
          `DELETE /v2/runs/${runId}/snapshot -> HTTP ${response.status}: ${text}`,
          { url, status: response.status }
        );
      }

      // Consume the response body to release the connection
      await response.text();
    },
  };
}
