/**
 * `code` on the error a queue request is aborted with when it runs past its
 * deadline (`QUEUE_REQUEST_TIMEOUT_MS` in http-client.ts), so the transport
 * classifier and a send's retry policy recognize it (see queue-send-retry.ts).
 *
 * A module of its own so http-client.ts and http-core.ts can both import it
 * without one depending on the other for it.
 */
export const QUEUE_REQUEST_DEADLINE_CODE = 'WORKFLOW_QUEUE_REQUEST_DEADLINE';
