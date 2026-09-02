/**
 * Deferred upload of a dynamic run's workflow VM code.
 *
 * A dynamic run carries its own workflow code, because that code is not in the
 * deployment's build-time manifest. Small definitions ride the `run_created`
 * frame's meta block and cost no extra round-trip — that is the common case
 * and does not come through here. This module is the escape hatch for the
 * tail: a definition too large to send inline is streamed to the backend
 * first, and the returned ref key is what `run_created` carries instead of the
 * bytes.
 *
 * The upload necessarily precedes the run it belongs to (the ref has to exist
 * before the write that references it), so the backend accepts a runId that
 * does not exist yet and authorizes on tenant. See
 * `World.uploadDynamicWorkflowCode` for the contract.
 */

import { z } from 'zod';
import { getEventsDispatcher } from './http-client.js';
import { instrumentedFetch } from './http-core.js';
import { type APIConfig, getHttpConfig } from './utils.js';

const UploadResponseSchema = z.object({
  /** Ref key to send as `run_created`'s `eventData.dynamicWorkflowCodeRef`. */
  ref: z.string().min(1),
  /** Stored byte count, echoed back for observability. */
  byteSize: z.number().int().nonnegative().optional(),
});

/**
 * Stream serialized workflow code to the backend and return its ref key.
 *
 * @param runId - Client-minted ID of the run being started. The backend
 *   embeds it in the storage key so the object is reclaimed with the run.
 * @param params.workflowName - The generated dynamic workflow name, also part
 *   of the key. Passed in because the run record does not exist yet.
 * @param params.code - Serialized (compressed + encrypted) workflow code.
 */
export async function uploadDynamicWorkflowCode(
  runId: string,
  params: { workflowName: string; code: Uint8Array },
  config?: APIConfig
): Promise<string> {
  const { baseUrl, headers } = await getHttpConfig(config);
  const url =
    `${baseUrl}/v4/runs/${encodeURIComponent(runId)}/dynamic-code` +
    `?workflowName=${encodeURIComponent(params.workflowName)}`;

  const requestHeaders = new Headers(headers);
  // The body is opaque bytes the backend streams straight to blob storage
  // without decoding, so it is neither CBOR nor JSON on the way up.
  requestHeaders.set('Content-Type', 'application/octet-stream');
  requestHeaders.set('Accept', 'application/json');
  requestHeaders.set('Content-Length', String(params.code.byteLength));

  const opName = 'uploadDynamicWorkflowCode';
  const response = await instrumentedFetch({
    method: 'POST',
    url,
    headers: requestHeaders,
    body: params.code,
    dispatcher: getEventsDispatcher(config),
    logLabel: opName,
    // No buildError override: the upload's error bodies are the standard
    // JSON `{ error, message }` envelope, which instrumentedFetch's default
    // path already turns into the right typed error.
  });

  return UploadResponseSchema.parse(await response.json()).ref;
}
