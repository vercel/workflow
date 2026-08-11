/**
 * `@workflow/world-sim` — a deterministic, fully in-memory World for playing
 * out workflow scenarios and checking the world contract holds.
 *
 * See the package README for the model. The short version: nothing in this
 * world happens on its own, every World method is a point a scenario can
 * inject at, and virtual time means a scenario that sleeps for a month still
 * finishes in milliseconds.
 *
 * This entry is the *scenario* surface: write one, play it, render the result,
 * and name anything those three hand you. The pieces that build or inspect the
 * simulator itself — `createSimWorld`, `createSimStore`, `driveQueue`,
 * `verifyReplay`, `checkInvariants`, the clock — are deliberately not here.
 * Nothing outside the package has wanted them, and re-exporting them makes
 * every one of their signatures a compatibility promise. Import them from their
 * module if you are extending the simulator; see `DESIGN.md`.
 */

// `buildSimBundle` is deliberately absent too, for a different reason: it
// reaches SWC and esbuild through `@workflow/builders`, and a consumer that
// only wants to *play* scenarios should not drag a compiler into its module
// graph. It is exported from `@workflow/world-sim/build` instead.
export type { SelectNext } from './drive.js';
export { loadFlowHandler } from './load.js';
export {
  type MarkdownSummaryOptions,
  type RenderOptions,
  renderMarkdownSummary,
  renderScenario,
  renderSummary,
} from './report.js';
export {
  type RunScenarioOptions,
  runScenario,
  type ScenarioExpectation,
  type ScenarioOutcome,
  type ScenarioResult,
  type ScenarioSpec,
} from './scenario.js';
export { ScenarioAborted } from './tempo.js';
export type {
  CallContext,
  CallMatch,
  CallPhase,
  Held,
  InFlightWrite,
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
export { AlreadyPassedError, RunToTimeoutError } from './writers.js';
