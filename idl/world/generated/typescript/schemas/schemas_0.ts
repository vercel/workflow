const _AC = "AttributeChange";
const _ACL = "AttributeChangeList";
const _ACO = "AlreadyCancelledOutcome";
const _ACV = "AttributeChangeValue";
const _ASE = "AttributesSetEvent";
const _AW = "AttributeWriter";
const _BCF = "BulkCancelFailure";
const _BCO = "BulkCancelOutcome";
const _BCR = "BulkCancelResult";
const _BCRI = "BulkCancelRunsInput";
const _BCRL = "BulkCancelResultList";
const _BCRO = "BulkCancelRunsOutput";
const _BCS = "BulkCancelSummary";
const _BGRI = "BatchGetRunsInput";
const _BGRO = "BatchGetRunsOutput";
const _BRE = "BadRequestError";
const _BS = "ByteStream";
const _CE = "ConflictError";
const _CEI = "CreateEventInput";
const _CEO = "CreateEventOptions";
const _CEr = "CreatableEvent";
const _CO = "CancelledOutcome";
const _CRI = "CreateRunInput";
const _CRII = "CreateRunIdInput";
const _CRIO = "CreateRunIdOutput";
const _CSI = "CloseStreamInput";
const _CSO = "CloseStreamOutput";
const _DQMI = "DeliverQueueMessageInput";
const _DQMO = "DeliverQueueMessageOutput";
const _DRI = "DescribeRunInput";
const _DRO = "DescribeRunOutput";
const _E = "Event";
const _EE = "ExpiredError";
const _EI = "EnqueueInput";
const _EK = "EncryptionKey";
const _EL = "EventList";
const _EMR = "EventMutationResult";
const _ENFE = "EventNotFoundError";
const _EO = "EnqueueOptions";
const _EOn = "EnqueueOutput";
const _EP = "EventPayload";
const _GDII = "GetDeploymentIdInput";
const _GDIO = "GetDeploymentIdOutput";
const _GEI = "GetEnvironmentInput";
const _GEIe = "GetEventInput";
const _GEKFRI = "GetEncryptionKeyForRunInput";
const _GEKFRO = "GetEncryptionKeyForRunOutput";
const _GEO = "GetEnvironmentOutput";
const _GEOe = "GetEventOutput";
const _GHBTI = "GetHookByTokenInput";
const _GHBTO = "GetHookByTokenOutput";
const _GHI = "GetHookInput";
const _GHO = "GetHookOutput";
const _GRDI = "GetRuntimeDeadlineInput";
const _GRDO = "GetRuntimeDeadlineOutput";
const _GRI = "GetRunInput";
const _GRO = "GetRunOutput";
const _GSI = "GetStepInput";
const _GSII = "GetStreamInfoInput";
const _GSIO = "GetStreamInfoOutput";
const _GSO = "GetStepOutput";
const _GWII = "GetWorldInfoInput";
const _GWIO = "GetWorldInfoOutput";
const _H = "Hook";
const _HCE = "HookConflictEvent";
const _HCEo = "HookCreatedEvent";
const _HDE = "HookDisposedEvent";
const _HL = "HookList";
const _HNFE = "HookNotFoundError";
const _HRC = "HookResumeCapabilities";
const _HRCo = "HookResumeContext";
const _HRCoo = "HookRetentionCapability";
const _HRE = "HookReceivedEvent";
const _IE = "InternalError";
const _LEBCII = "ListEventsByCorrelationIdInput";
const _LEBCIO = "ListEventsByCorrelationIdOutput";
const _LEI = "ListEventsInput";
const _LEO = "ListEventsOutput";
const _LHI = "ListHooksInput";
const _LHO = "ListHooksOutput";
const _LRI = "ListRunsInput";
const _LRO = "ListRunsOutput";
const _LSCI = "ListStreamChunksInput";
const _LSCO = "ListStreamChunksOutput";
const _LSI = "ListStepsInput";
const _LSIi = "ListStreamsInput";
const _LSO = "ListStepsOutput";
const _LSOi = "ListStreamsOutput";
const _NCO = "NotCancellableOutcome";
const _P = "Pagination";
const _PFE = "PreconditionFailedError";
const _PI = "PageInfo";
const _RA = "RemoveAttribute";
const _RCE = "RunCancelledEvent";
const _RCEu = "RunCompletedEvent";
const _RCEun = "RunCreatedEvent";
const _RD = "RetryDirective";
const _RDF = "RunDisplayFields";
const _RFE = "RunFailedEvent";
const _RNFE = "RunNotFoundError";
const _RNFO = "RunNotFoundOutcome";
const _RSE = "RunStartedEvent";
const _RSI = "ReadStreamInput";
const _RSO = "ReadStreamOutput";
const _S = "Step";
const _SAW = "StepAttributeWriter";
const _SC = "StreamChunk";
const _SCE = "StepCompletedEvent";
const _SCEt = "StepCreatedEvent";
const _SCL = "StreamChunkList";
const _SE = "StructuredError";
const _SEE = "StreamExpiredError";
const _SFE = "StepFailedEvent";
const _SL = "StepList";
const _SLT = "StepLatencyTelemetry";
const _SNFE = "StepNotFoundError";
const _SNFEt = "StreamNotFoundError";
const _SRE = "StepRetryingEvent";
const _SSE = "StepStartedEvent";
const _SWRL = "SparseWorkflowRunList";
const _TE = "ThrottledError";
const _TEE = "TooEarlyError";
const _W = "Wait";
const _WAW = "WorkflowAttributeWriter";
const _WC = "WorldCapabilities";
const _WCE = "WaitCompletedEvent";
const _WCEa = "WaitCreatedEvent";
const _WR = "WorkflowRun";
const _WRL = "WorkflowRunList";
const _WSCI = "WriteStreamChunkInput";
const _WSCIr = "WriteStreamChunksInput";
const _WSCO = "WriteStreamChunkOutput";
const _WSCOr = "WriteStreamChunksOutput";
const _a = "attempt";
const _aC = "alreadyCancelled";
const _aRA = "allowReservedAttributes";
const _aS = "attributesSet";
const _ac = "active";
const _at = "attributes";
const _b = "body";
const _c = "client";
const _cA = "createdAt";
const _cAo = "completedAt";
const _cI = "correlationId";
const _cII = "computeInstanceId";
const _cLD = "currentLookbackDays";
const _cR = "cancelReason";
const _cRI = "conflictingRunId";
const _cWS = "currentWindowStart";
const _ca = "cancelled";
const _cal = "callback";
const _cap = "capabilities";
const _ch = "change";
const _cha = "changes";
const _chu = "chunks";
const _chun = "chunk";
const _co = "code";
const _con = "context";
const _cu = "cursor";
const _d = "deadline";
const _dA = "deploymentAffinity";
const _dI = "deploymentId";
const _dS = "delaySeconds";
const _da = "data";
const _do = "done";
const _e = "error";
const _eA = "expiredAt";
const _eC = "eventCount";
const _eCr = "errorCode";
const _eCx = "executionContext";
const _eI = "eventId";
const _ePK = "encryptionPublicKey";
const _en = "environment";
const _ev = "event";
const _eve = "events";
const _f = "failed";
const _fSR = "finalSchedulingReplay";
const _fi = "fields";
const _h = "headers";
const _hC = "hookCreated";
const _hCo = "hookConflict";
const _hD = "hookDisposed";
const _hI = "hookId";
const _hM = "hasMore";
const _hR = "hookRetention";
const _hRD = "hookResumeDedup";
const _hRDV = "hookResumeDedupVersion";
const _hRIV = "hookResumeInputVersion";
const _hRo = "hookReceived";
const _ho = "hook";
const _hoo = "hooks";
const _i = "input";
const _iK = "idempotencyKey";
const _iS = "isSystem";
const _iW = "isWebhook";
const _in = "index";
const _k = "key";
const _l = "limit";
const _lO = "localOnly";
const _m = "message";
const _mC = "maxConcurrency";
const _mE = "maxEvents";
const _mI = "messageId";
const _mLD = "maxLookbackDays";
const _mWS = "maxWindowStart";
const _me = "metadata";
const _n = "name";
const _nC = "notCancellable";
const _nF = "notFound";
const _na = "names";
const _o = "outcome";
const _oA = "occurredAt";
const _oC = "optionalCapabilities";
const _oCp = "optionalCapability";
const _oI = "ownerId";
const _oMI = "ownerMessageId";
const _op = "options";
const _opt = "optimizations";
const _ou = "output";
const _p = "payload";
const _pE = "preloadEvents";
const _pG = "preconditionGuard";
const _pI = "projectId";
const _pIa = "pageInfo";
const _qN = "queueName";
const _r = "runs";
const _rA = "retryAfter";
const _rAe = "resumeAt";
const _rC = "resumeContext";
const _rCe = "resumeCapabilities";
const _rCu = "runCompleted";
const _rCun = "runCancelled";
const _rCunr = "runCreated";
const _rD = "resolveData";
const _rDC = "replayDivergenceCount";
const _rF = "runFailed";
const _rI = "runId";
const _rIe = "resumeId";
const _rIeq = "requestId";
const _rIu = "runIds";
const _rPD = "resumePayloadDigest";
const _rS = "runStarted";
const _rSV = "runSpecVersion";
const _re = "retryable";
const _reg = "region";
const _rem = "remove";
const _req = "requested";
const _res = "results";
const _resu = "result";
const _ret = "retry";
const _rs = "rsfs";
const _ru = "run";
const _s = "status";
const _sA = "startedAt";
const _sC = "sinceCursor";
const _sCt = "stepCreated";
const _sCte = "stepCount";
const _sCtep = "stepCompleted";
const _sEI = "slotEventIds";
const _sF = "stepFailed";
const _sI = "stepId";
const _sIt = "startIndex";
const _sN = "streamName";
const _sNt = "stepName";
const _sO = "sortOrder";
const _sP = "skipPreload";
const _sR = "stepRetrying";
const _sS = "stepStarted";
const _sV = "specVersion";
const _se = "server";
const _set = "set";
const _sp = "sparse";
const _st = "streaming";
const _sta = "stack";
const _ste = "step";
const _step = "steps";
const _sts = "stso";
const _su = "summary";
const _t = "token";
const _tC = "traceCarrier";
const _tI = "tailIndex";
const _tRU = "tokenRetentionUntil";
const _tS = "timeoutSeconds";
const _te = "telemetry";
const _tt = "ttfs";
const _uA = "upgradeAvailable";
const _uAp = "updatedAt";
const _vC = "v1Compat";
const _vSD = "viaStepDispatch";
const _w = "writer";
const _wC = "waitCreated";
const _wCV = "workflowCoreVersion";
const _wCa = "waitCompleted";
const _wI = "waitId";
const _wN = "workflowName";
const _wa = "wait";
const _wo = "workflow";
const n0 = "vercel.workflow.world";

// smithy-typescript generated code
import { TypeRegistry } from "@smithy/core/schema";
import type {
  StaticErrorSchema,
  StaticListSchema,
  StaticMapSchema,
  StaticSimpleSchema,
  StaticStructureSchema,
  StaticUnionSchema,
} from "@smithy/types";

import {
  BadRequestError,
  ConflictError,
  EventNotFoundError,
  ExpiredError,
  HookNotFoundError,
  InternalError,
  PreconditionFailedError,
  RunNotFoundError,
  StepNotFoundError,
  StreamExpiredError,
  StreamNotFoundError,
  ThrottledError,
  TooEarlyError,
} from "../models/errors";

/* eslint no-var: 0 */
const n0_registry = TypeRegistry.for(n0);
export var BadRequestError$: StaticErrorSchema = [-3, n0, _BRE,
  { [_e]: _c },
  [_m, _co],
  [0, 0], 1
];
n0_registry.registerError(BadRequestError$, BadRequestError);
export var ConflictError$: StaticErrorSchema = [-3, n0, _CE,
  { [_e]: _c },
  [_m, _s],
  [0, 0], 1
];
n0_registry.registerError(ConflictError$, ConflictError);
export var EventNotFoundError$: StaticErrorSchema = [-3, n0, _ENFE,
  { [_e]: _c },
  [_m, _rI, _eI],
  [0, 0, 0], 1
];
n0_registry.registerError(EventNotFoundError$, EventNotFoundError);
export var ExpiredError$: StaticErrorSchema = [-3, n0, _EE,
  { [_e]: _c },
  [_m, _rI],
  [0, 0], 1
];
n0_registry.registerError(ExpiredError$, ExpiredError);
export var HookNotFoundError$: StaticErrorSchema = [-3, n0, _HNFE,
  { [_e]: _c },
  [_m, _hI],
  [0, 0], 1
];
n0_registry.registerError(HookNotFoundError$, HookNotFoundError);
export var InternalError$: StaticErrorSchema = [-3, n0, _IE,
  { [_e]: _se },
  [_m, _co],
  [0, 0], 1
];
n0_registry.registerError(InternalError$, InternalError);
export var PreconditionFailedError$: StaticErrorSchema = [-3, n0, _PFE,
  { [_e]: _c },
  [_m, _eC],
  [0, 1], 1
];
n0_registry.registerError(PreconditionFailedError$, PreconditionFailedError);
export var RunNotFoundError$: StaticErrorSchema = [-3, n0, _RNFE,
  { [_e]: _c },
  [_m, _rI],
  [0, 0], 1
];
n0_registry.registerError(RunNotFoundError$, RunNotFoundError);
export var StepNotFoundError$: StaticErrorSchema = [-3, n0, _SNFE,
  { [_e]: _c },
  [_m, _rI, _sI],
  [0, 0, 0], 1
];
n0_registry.registerError(StepNotFoundError$, StepNotFoundError);
export var StreamExpiredError$: StaticErrorSchema = [-3, n0, _SEE,
  { [_e]: _c },
  [_m, _rI, _sN],
  [0, 0, 0], 1
];
n0_registry.registerError(StreamExpiredError$, StreamExpiredError);
export var StreamNotFoundError$: StaticErrorSchema = [-3, n0, _SNFEt,
  { [_e]: _c },
  [_m, _rI, _sN],
  [0, 0, 0], 1
];
n0_registry.registerError(StreamNotFoundError$, StreamNotFoundError);
export var ThrottledError$: StaticErrorSchema = [-3, n0, _TE,
  { [_e]: _c },
  [_m, _rA],
  [0, 4], 1
];
n0_registry.registerError(ThrottledError$, ThrottledError);
export var TooEarlyError$: StaticErrorSchema = [-3, n0, _TEE,
  { [_e]: _c },
  [_m, _rA],
  [0, 4], 1
];
n0_registry.registerError(TooEarlyError$, TooEarlyError);
/**
 * TypeRegistry instances containing modeled errors.
 * @internal
 *
 */
export const errorTypeRegistries = [
  n0_registry,
]
var ByteStream: StaticSimpleSchema = [0, n0, _BS, { [_st]: 1 }, 42];
var EncryptionKey: StaticSimpleSchema = [0, n0, _EK, 8, 21];
var __Unit = "unit" as const;
export var AlreadyCancelledOutcome$: StaticStructureSchema = [3, n0, _ACO,
  0,
  [],
  []
];
export var AttributeChange$: StaticStructureSchema = [3, n0, _AC,
  0,
  [_k, _ch],
  [0, () => AttributeChangeValue$], 2
];
export var AttributesSetEvent$: StaticStructureSchema = [3, n0, _ASE,
  0,
  [_cha, _w, _aRA],
  [() => AttributeChangeList, () => AttributeWriter$, 2], 2
];
export var BatchGetRunsInput$: StaticStructureSchema = [3, n0, _BGRI,
  0,
  [_rIu, _rD],
  [64 | 0, 0], 1
];
export var BatchGetRunsOutput$: StaticStructureSchema = [3, n0, _BGRO,
  0,
  [_r],
  [[() => SparseWorkflowRunList, 0]], 1
];
export var BulkCancelFailure$: StaticStructureSchema = [3, n0, _BCF,
  0,
  [_co, _re],
  [0, 2], 2
];
export var BulkCancelResult$: StaticStructureSchema = [3, n0, _BCR,
  0,
  [_rI, _o],
  [0, () => BulkCancelOutcome$], 2
];
export var BulkCancelRunsInput$: StaticStructureSchema = [3, n0, _BCRI,
  0,
  [_rIu, _cR],
  [64 | 0, 0], 1
];
export var BulkCancelRunsOutput$: StaticStructureSchema = [3, n0, _BCRO,
  0,
  [_su, _res],
  [() => BulkCancelSummary$, () => BulkCancelResultList], 2
];
export var BulkCancelSummary$: StaticStructureSchema = [3, n0, _BCS,
  0,
  [_req, _ca, _aC, _nC, _nF, _f],
  [1, 1, 1, 1, 1, 1], 6
];
export var callback$: StaticStructureSchema = [3, n0, _cal,
  0,
  [],
  []
];
export var CancelledOutcome$: StaticStructureSchema = [3, n0, _CO,
  0,
  [],
  []
];
export var CloseStreamInput$: StaticStructureSchema = [3, n0, _CSI,
  0,
  [_rI, _n],
  [0, 0], 2
];
export var CloseStreamOutput$: StaticStructureSchema = [3, n0, _CSO,
  0,
  [],
  []
];
export var CreateEventInput$: StaticStructureSchema = [3, n0, _CEI,
  0,
  [_rI, _ev, _op],
  [0, () => CreatableEvent$, () => CreateEventOptions$], 2
];
export var CreateEventOptions$: StaticStructureSchema = [3, n0, _CEO,
  0,
  [_vC, _rD, _rIe, _rPD, _vSD, _rIeq, _cII, _eC, _oA, _rDC, _sC, _sP, _pE],
  [2, 0, 0, 0, 2, 0, 0, 1, 4, 1, 0, 2, 2]
];
export var CreateRunIdInput$: StaticStructureSchema = [3, n0, _CRII,
  0,
  [_op],
  [15]
];
export var CreateRunIdOutput$: StaticStructureSchema = [3, n0, _CRIO,
  0,
  [_rI],
  [0], 1
];
export var CreateRunInput$: StaticStructureSchema = [3, n0, _CRI,
  0,
  [_ev, _rI, _op],
  [() => RunCreatedEvent$, 0, () => CreateEventOptions$], 1
];
export var DeliverQueueMessageInput$: StaticStructureSchema = [3, n0, _DQMI,
  0,
  [_qN, _m, _a, _mI, _rIeq],
  [0, 21, 1, 0, 0], 4
];
export var DeliverQueueMessageOutput$: StaticStructureSchema = [3, n0, _DQMO,
  0,
  [_ret],
  [() => RetryDirective$]
];
export var DescribeRunInput$: StaticStructureSchema = [3, n0, _DRI,
  0,
  [_ru],
  [15], 1
];
export var DescribeRunOutput$: StaticStructureSchema = [3, n0, _DRO,
  0,
  [_fi],
  [[() => RunDisplayFields, 0]]
];
export var EnqueueInput$: StaticStructureSchema = [3, n0, _EI,
  0,
  [_qN, _m, _op],
  [0, 21, () => EnqueueOptions$], 2
];
export var EnqueueOptions$: StaticStructureSchema = [3, n0, _EO,
  0,
  [_dI, _iK, _h, _dS, _sV, _reg],
  [0, 0, 128 | 0, 1, 1, 0]
];
export var EnqueueOutput$: StaticStructureSchema = [3, n0, _EOn,
  0,
  [_mI],
  [0]
];
export var Event$: StaticStructureSchema = [3, n0, _E,
  0,
  [_eI, _rI, _p, _cA, _cI, _sV, _oA, _rIe],
  [0, 0, () => EventPayload$, 4, 0, 1, 4, 0], 4
];
export var EventMutationResult$: StaticStructureSchema = [3, n0, _EMR,
  0,
  [_ev, _ru, _ste, _ho, _wa, _sCt, _mE, _eve, _cu, _hM],
  [() => Event$, () => WorkflowRun$, () => Step$, () => Hook$, () => Wait$, 2, 1, () => EventList, 0, 2]
];
export var GetDeploymentIdInput$: StaticStructureSchema = [3, n0, _GDII,
  0,
  [],
  []
];
export var GetDeploymentIdOutput$: StaticStructureSchema = [3, n0, _GDIO,
  0,
  [_dI],
  [0], 1
];
export var GetEncryptionKeyForRunInput$: StaticStructureSchema = [3, n0, _GEKFRI,
  0,
  [_rI, _con],
  [0, 15], 1
];
export var GetEncryptionKeyForRunOutput$: StaticStructureSchema = [3, n0, _GEKFRO,
  0,
  [_k],
  [[() => EncryptionKey, 0]]
];
export var GetEnvironmentInput$: StaticStructureSchema = [3, n0, _GEI,
  0,
  [],
  []
];
export var GetEnvironmentOutput$: StaticStructureSchema = [3, n0, _GEO,
  0,
  [_en],
  [0]
];
export var GetEventInput$: StaticStructureSchema = [3, n0, _GEIe,
  0,
  [_rI, _eI, _rD],
  [0, 0, 0], 2
];
export var GetEventOutput$: StaticStructureSchema = [3, n0, _GEOe,
  0,
  [_ev],
  [() => Event$], 1
];
export var GetHookByTokenInput$: StaticStructureSchema = [3, n0, _GHBTI,
  0,
  [_t, _rD],
  [0, 0], 1
];
export var GetHookByTokenOutput$: StaticStructureSchema = [3, n0, _GHBTO,
  0,
  [_ho],
  [() => Hook$], 1
];
export var GetHookInput$: StaticStructureSchema = [3, n0, _GHI,
  0,
  [_hI, _rI, _rD],
  [0, 0, 0], 1
];
export var GetHookOutput$: StaticStructureSchema = [3, n0, _GHO,
  0,
  [_ho],
  [() => Hook$], 1
];
export var GetRunInput$: StaticStructureSchema = [3, n0, _GRI,
  0,
  [_rI, _rD],
  [0, 0], 1
];
export var GetRunOutput$: StaticStructureSchema = [3, n0, _GRO,
  0,
  [_ru],
  [() => WorkflowRun$], 1
];
export var GetRuntimeDeadlineInput$: StaticStructureSchema = [3, n0, _GRDI,
  0,
  [],
  []
];
export var GetRuntimeDeadlineOutput$: StaticStructureSchema = [3, n0, _GRDO,
  0,
  [_d],
  [4]
];
export var GetStepInput$: StaticStructureSchema = [3, n0, _GSI,
  0,
  [_rI, _sI, _rD],
  [0, 0, 0], 2
];
export var GetStepOutput$: StaticStructureSchema = [3, n0, _GSO,
  0,
  [_ste],
  [() => Step$], 1
];
export var GetStreamInfoInput$: StaticStructureSchema = [3, n0, _GSII,
  0,
  [_rI, _n],
  [0, 0], 2
];
export var GetStreamInfoOutput$: StaticStructureSchema = [3, n0, _GSIO,
  0,
  [_tI, _do],
  [1, 2], 2
];
export var GetWorldInfoInput$: StaticStructureSchema = [3, n0, _GWII,
  0,
  [],
  []
];
export var GetWorldInfoOutput$: StaticStructureSchema = [3, n0, _GWIO,
  0,
  [_sV, _cap, _oC],
  [1, () => WorldCapabilities$, 64 | 0], 1
];
export var Hook$: StaticStructureSchema = [3, n0, _H,
  0,
  [_rI, _hI, _t, _oI, _pI, _en, _cA, _me, _sV, _iW, _iS, _tRU, _rC, _rCe],
  [0, 0, 0, 0, 0, 0, 4, 21, 1, 2, 2, 4, () => HookResumeContext$, () => HookResumeCapabilities$], 7
];
export var HookConflictEvent$: StaticStructureSchema = [3, n0, _HCE,
  0,
  [_t, _cRI],
  [0, 0], 1
];
export var HookCreatedEvent$: StaticStructureSchema = [3, n0, _HCEo,
  0,
  [_t, _tRU, _me, _iW, _iS],
  [0, 4, 21, 2, 2], 1
];
export var HookDisposedEvent$: StaticStructureSchema = [3, n0, _HDE,
  0,
  [_t],
  [0]
];
export var HookReceivedEvent$: StaticStructureSchema = [3, n0, _HRE,
  0,
  [_p, _t],
  [21, 0], 1
];
export var HookResumeCapabilities$: StaticStructureSchema = [3, n0, _HRC,
  0,
  [_hRDV],
  [1], 1
];
export var HookResumeContext$: StaticStructureSchema = [3, n0, _HRCo,
  0,
  [_dI, _wN, _rSV, _wCV, _tC, _ePK, _hRIV],
  [0, 0, 1, 0, 128 | 0, 0, 1], 2
];
export var HookRetentionCapability$: StaticStructureSchema = [3, n0, _HRCoo,
  0,
  [_ac],
  [2], 1
];
export var ListEventsByCorrelationIdInput$: StaticStructureSchema = [3, n0, _LEBCII,
  0,
  [_rI, _cI, _rD, _l, _cu, _sO],
  [0, 0, 0, 1, 0, 0], 2
];
export var ListEventsByCorrelationIdOutput$: StaticStructureSchema = [3, n0, _LEBCIO,
  0,
  [_eve, _hM, _cu],
  [() => EventList, 2, 0], 2
];
export var ListEventsInput$: StaticStructureSchema = [3, n0, _LEI,
  0,
  [_rI, _rD, _l, _cu, _sO],
  [0, 0, 1, 0, 0], 1
];
export var ListEventsOutput$: StaticStructureSchema = [3, n0, _LEO,
  0,
  [_eve, _hM, _cu],
  [() => EventList, 2, 0], 2
];
export var ListHooksInput$: StaticStructureSchema = [3, n0, _LHI,
  0,
  [_rI, _rD, _l, _cu, _sO],
  [0, 0, 1, 0, 0]
];
export var ListHooksOutput$: StaticStructureSchema = [3, n0, _LHO,
  0,
  [_hoo, _hM, _cu],
  [() => HookList, 2, 0], 2
];
export var ListRunsInput$: StaticStructureSchema = [3, n0, _LRI,
  0,
  [_wN, _s, _rD, _l, _cu, _sO],
  [0, 0, 0, 1, 0, 0]
];
export var ListRunsOutput$: StaticStructureSchema = [3, n0, _LRO,
  0,
  [_r, _hM, _cu, _pIa],
  [() => WorkflowRunList, 2, 0, () => PageInfo$], 2
];
export var ListStepsInput$: StaticStructureSchema = [3, n0, _LSI,
  0,
  [_rI, _rD, _l, _cu, _sO],
  [0, 0, 1, 0, 0], 1
];
export var ListStepsOutput$: StaticStructureSchema = [3, n0, _LSO,
  0,
  [_step, _hM, _cu],
  [() => StepList, 2, 0], 2
];
export var ListStreamChunksInput$: StaticStructureSchema = [3, n0, _LSCI,
  0,
  [_rI, _n, _l, _cu],
  [0, 0, 1, 0], 2
];
export var ListStreamChunksOutput$: StaticStructureSchema = [3, n0, _LSCO,
  0,
  [_chu, _hM, _do, _cu],
  [() => StreamChunkList, 2, 2, 0], 3
];
export var ListStreamsInput$: StaticStructureSchema = [3, n0, _LSIi,
  0,
  [_rI],
  [0], 1
];
export var ListStreamsOutput$: StaticStructureSchema = [3, n0, _LSOi,
  0,
  [_na],
  [64 | 0], 1
];
export var localOnly$: StaticStructureSchema = [3, n0, _lO,
  0,
  [],
  []
];
export var NotCancellableOutcome$: StaticStructureSchema = [3, n0, _NCO,
  0,
  [_s],
  [0], 1
];
export var optionalCapability$: StaticStructureSchema = [3, n0, _oCp,
  0,
  [_n],
  [0], 1
];
export var PageInfo$: StaticStructureSchema = [3, n0, _PI,
  0,
  [_cLD, _mLD, _cWS, _mWS, _uA],
  [1, 1, 4, 4, 2], 5
];
export var Pagination$: StaticStructureSchema = [3, n0, _P,
  0,
  [_l, _cu, _sO],
  [1, 0, 0]
];
export var ReadStreamInput$: StaticStructureSchema = [3, n0, _RSI,
  0,
  [_rI, _n, _sIt],
  [0, 0, 1], 2
];
export var ReadStreamOutput$: StaticStructureSchema = [3, n0, _RSO,
  0,
  [_b],
  [[() => ByteStream, 0]], 1
];
export var RemoveAttribute$: StaticStructureSchema = [3, n0, _RA,
  0,
  [],
  []
];
export var RetryDirective$: StaticStructureSchema = [3, n0, _RD,
  0,
  [_tS],
  [1], 1
];
export var RunCancelledEvent$: StaticStructureSchema = [3, n0, _RCE,
  0,
  [_cR],
  [0]
];
export var RunCompletedEvent$: StaticStructureSchema = [3, n0, _RCEu,
  0,
  [_ou],
  [21]
];
export var RunCreatedEvent$: StaticStructureSchema = [3, n0, _RCEun,
  0,
  [_dI, _wN, _i, _eCx, _at, _aRA, _ePK],
  [0, 0, 21, 15, 128 | 0, 2, 0], 3
];
export var RunFailedEvent$: StaticStructureSchema = [3, n0, _RFE,
  0,
  [_e, _eCr],
  [21, 0], 1
];
export var RunNotFoundOutcome$: StaticStructureSchema = [3, n0, _RNFO,
  0,
  [],
  []
];
export var RunStartedEvent$: StaticStructureSchema = [3, n0, _RSE,
  0,
  [_i, _dI, _wN, _eCx, _at, _aRA, _ePK],
  [21, 0, 0, 15, 128 | 0, 2, 0]
];
export var Step$: StaticStructureSchema = [3, n0, _S,
  0,
  [_rI, _sI, _sNt, _s, _a, _cA, _uAp, _i, _ou, _e, _sA, _cAo, _rA, _sV],
  [0, 0, 0, 0, 1, 4, 4, 21, 21, 21, 4, 4, 4, 1], 7
];
export var StepAttributeWriter$: StaticStructureSchema = [3, n0, _SAW,
  0,
  [_sI, _a],
  [0, 1], 2
];
export var StepCompletedEvent$: StaticStructureSchema = [3, n0, _SCE,
  0,
  [_resu, _sNt, _wN, _te],
  [21, 0, 0, () => StepLatencyTelemetry$], 1
];
export var StepCreatedEvent$: StaticStructureSchema = [3, n0, _SCEt,
  0,
  [_sNt, _i, _wN],
  [0, 21, 0], 2
];
export var StepFailedEvent$: StaticStructureSchema = [3, n0, _SFE,
  0,
  [_e, _sNt, _te],
  [21, 0, () => StepLatencyTelemetry$], 1
];
export var StepLatencyTelemetry$: StaticStructureSchema = [3, n0, _SLT,
  0,
  [_tt, _sts, _sCte, _eC, _rs, _fSR, _opt],
  [1, 1, 1, 1, 1, 1, 64 | 0]
];
export var StepRetryingEvent$: StaticStructureSchema = [3, n0, _SRE,
  0,
  [_e, _sNt, _rA],
  [21, 0, 4], 1
];
export var StepStartedEvent$: StaticStructureSchema = [3, n0, _SSE,
  0,
  [_sNt, _a, _wN, _i, _oMI],
  [0, 1, 0, 21, 0]
];
export var StreamChunk$: StaticStructureSchema = [3, n0, _SC,
  0,
  [_in, _da],
  [1, 21], 2
];
export var StructuredError$: StaticStructureSchema = [3, n0, _SE,
  0,
  [_m, _sta, _co],
  [0, 0, 0], 1
];
export var Wait$: StaticStructureSchema = [3, n0, _W,
  0,
  [_rI, _wI, _rAe, _cA, _cAo],
  [0, 0, 4, 4, 4], 4
];
export var WaitCompletedEvent$: StaticStructureSchema = [3, n0, _WCE,
  0,
  [_rAe],
  [4]
];
export var WaitCreatedEvent$: StaticStructureSchema = [3, n0, _WCEa,
  0,
  [_rAe],
  [4], 1
];
export var WorkflowAttributeWriter$: StaticStructureSchema = [3, n0, _WAW,
  0,
  [],
  []
];
export var WorkflowRun$: StaticStructureSchema = [3, n0, _WR,
  0,
  [_rI, _s, _dI, _wN, _at, _cA, _uAp, _sV, _eCx, _i, _ou, _e, _eCr, _ePK, _eA, _sA, _cAo],
  [0, 0, 0, 0, 128 | 0, 4, 4, 1, 15, 21, 21, 21, 0, 0, 4, 4, 4], 7
];
export var WorldCapabilities$: StaticStructureSchema = [3, n0, _WC,
  0,
  [_hR, _pG, _mC, _hRD, _dA, _sEI],
  [() => HookRetentionCapability$, 2, 2, 2, 2, 2]
];
export var WriteStreamChunkInput$: StaticStructureSchema = [3, n0, _WSCI,
  0,
  [_rI, _n, _chun],
  [0, 0, 21], 3
];
export var WriteStreamChunkOutput$: StaticStructureSchema = [3, n0, _WSCO,
  0,
  [],
  []
];
export var WriteStreamChunksInput$: StaticStructureSchema = [3, n0, _WSCIr,
  0,
  [_rI, _n, _chu],
  [0, 0, 64 | 21], 3
];
export var WriteStreamChunksOutput$: StaticStructureSchema = [3, n0, _WSCOr,
  0,
  [],
  []
];
var AttributeChangeList: StaticListSchema = [1, n0, _ACL,
  0, () => AttributeChange$
];
var BulkCancelResultList: StaticListSchema = [1, n0, _BCRL,
  0, () => BulkCancelResult$
];
var CapabilityNameList = 64 | 0;
var ChunkDataList = 64 | 21;
var EventList: StaticListSchema = [1, n0, _EL,
  0, () => Event$
];
var HookList: StaticListSchema = [1, n0, _HL,
  0, () => Hook$
];
var RunIdList = 64 | 0;
var SparseWorkflowRunList: StaticListSchema = [1, n0, _SWRL,
  { [_sp]: 1 }, () => WorkflowRun$
];
var StepList: StaticListSchema = [1, n0, _SL,
  0, () => Step$
];
var StreamChunkList: StaticListSchema = [1, n0, _SCL,
  0, () => StreamChunk$
];
var StreamNameList = 64 | 0;
var StringList = 64 | 0;
var WorkflowRunList: StaticListSchema = [1, n0, _WRL,
  0, () => WorkflowRun$
];
var AttributeMap = 128 | 0;
var QueueHeaders = 128 | 0;
var RunDisplayFields: StaticMapSchema = [2, n0, _RDF,
  { [_sp]: 1 }, 0, 0
];
var TraceCarrier = 128 | 0;
export var AttributeChangeValue$: StaticUnionSchema = [4, n0, _ACV,
  0,
  [_set, _rem],
  [0, () => RemoveAttribute$]
];
export var AttributeWriter$: StaticUnionSchema = [4, n0, _AW,
  0,
  [_wo, _ste],
  [() => WorkflowAttributeWriter$, () => StepAttributeWriter$]
];
export var BulkCancelOutcome$: StaticUnionSchema = [4, n0, _BCO,
  0,
  [_ca, _aC, _nC, _nF, _f],
  [() => CancelledOutcome$, () => AlreadyCancelledOutcome$, () => NotCancellableOutcome$, () => RunNotFoundOutcome$, () => BulkCancelFailure$]
];
export var CreatableEvent$: StaticUnionSchema = [4, n0, _CEr,
  0,
  [_rS, _rCu, _rF, _rCun, _aS, _sCt, _sS, _sCtep, _sF, _sR, _hC, _hRo, _hD, _wC, _wCa],
  [() => RunStartedEvent$, () => RunCompletedEvent$, () => RunFailedEvent$, () => RunCancelledEvent$, () => AttributesSetEvent$, () => StepCreatedEvent$, () => StepStartedEvent$, () => StepCompletedEvent$, () => StepFailedEvent$, () => StepRetryingEvent$, () => HookCreatedEvent$, () => HookReceivedEvent$, () => HookDisposedEvent$, () => WaitCreatedEvent$, () => WaitCompletedEvent$]
];
export var EventPayload$: StaticUnionSchema = [4, n0, _EP,
  0,
  [_rCunr, _rS, _rCu, _rF, _rCun, _aS, _sCt, _sS, _sCtep, _sF, _sR, _hC, _hRo, _hD, _hCo, _wC, _wCa],
  [() => RunCreatedEvent$, () => RunStartedEvent$, () => RunCompletedEvent$, () => RunFailedEvent$, () => RunCancelledEvent$, () => AttributesSetEvent$, () => StepCreatedEvent$, () => StepStartedEvent$, () => StepCompletedEvent$, () => StepFailedEvent$, () => StepRetryingEvent$, () => HookCreatedEvent$, () => HookReceivedEvent$, () => HookDisposedEvent$, () => HookConflictEvent$, () => WaitCreatedEvent$, () => WaitCompletedEvent$]
];
