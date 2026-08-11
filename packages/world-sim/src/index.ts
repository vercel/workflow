/**
 * `@workflow/world-sim` — a deterministic, fully in-memory World for playing
 * out workflow scenarios and checking the world contract holds.
 *
 * See the package README for the model. The short version: nothing in this
 * world happens on its own, every World method is a point a scenario can
 * inject at, and virtual time means a scenario that sleeps for a month still
 * finishes in milliseconds.
 */

export {
  createVirtualClock,
  DEFAULT_EPOCH_MS,
  type VirtualClock,
} from './clock.js';
export {
  DEFAULT_LIMITS,
  type DriveResult,
  driveQueue,
  type ScenarioLimits,
  type SelectNext,
} from './drive.js';
export { checkInvariants, type InvariantInput } from './invariants.js';
// `buildSimBundle` is deliberately absent from this entry: it reaches SWC and
// esbuild through `@workflow/builders`, and a consumer that only wants to
// *play* scenarios should not drag a compiler into its module graph. It is
// exported from `@workflow/world-sim/build` instead.
export { loadFlowHandler } from './load.js';
export {
  type ReplayCheckInput,
  type ReplayCheckResult,
  verifyReplay,
} from './replay.js';
export {
  type MarkdownSummaryOptions,
  type RenderOptions,
  renderMarkdownSummary,
  renderScenario,
  renderSummary,
  renderTrace,
} from './report.js';
export {
  type RunScenarioOptions,
  runScenario,
  type ScenarioExpectation,
  type ScenarioOutcome,
  type ScenarioResult,
  type ScenarioSpec,
} from './scenario.js';
export {
  createSimStore,
  type SimStore,
  type SimStoreOptions,
  type StaleRead,
} from './store.js';
export { ScenarioAborted } from './tempo.js';
export type {
  CallContext,
  CallMatch,
  CallPhase,
  Held,
  InvariantViolation,
  ObservedPoint,
  Parked,
  PendingMessageView,
  RejectedCall,
  RunToOptions,
  ScenarioApi,
  ScenarioScript,
  Tempo,
  TraceEntry,
  WorldCallName,
  WorldSnapshot,
  Writer,
  WriterHandles,
  WriterId,
} from './types.js';
export {
  createSimWorld,
  type SimWorld,
  type SimWorldOptions,
  WORKFLOW_QUEUE_PREFIX,
} from './world.js';
export { AlreadyPassedError, RunToTimeoutError } from './writers.js';
