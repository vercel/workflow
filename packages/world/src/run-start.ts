export interface RunStartReservation {
  reservationId: string;
  runId: string;
  startShapeDigest: string;
  inserted: boolean;
}

export interface ReserveOrAdoptRunStartRequest {
  idempotencyKey: string;
  startShapeDigest: string;
  workflowName: string;
  deploymentId: string;
  namespace?: string;
  region?: string;
  specVersion: number;
}

export interface FinalizeOrAdoptRunStartRequest {
  reservationId: string;
  runId: string;
  semanticDigest: string;
  envelopeIntegrityDigest: string;
  envelope: unknown;
  queueName: string;
  queuePayload: unknown;
  queueOptions: unknown;
}

export interface FinalizedRunStart {
  inserted: boolean;
  runId: string;
  semanticDigest: string;
  envelopeIntegrityDigest: string;
  messageId: string;
  dispatchState: 'pending' | 'acknowledged';
}

export interface RunStarts {
  reserveOrAdoptRunStart(
    request: ReserveOrAdoptRunStartRequest
  ): Promise<RunStartReservation>;
  finalizeOrAdoptRunStart(
    request: FinalizeOrAdoptRunStartRequest
  ): Promise<FinalizedRunStart>;
  /** Backend-owned recovery/projection drain. Absent worlds do not attest v1. */
  drain?(): Promise<void>;
}
