export type NoteSeverity = 'todo' | 'info';

export interface MigrationNote {
  severity: NoteSeverity;
  line: number;
  message: string;
}

export interface CapturedVariable {
  name: string;
  /** Line of the declaration in the original file. */
  declaredAt: number;
  kind: 'parameter' | 'variable' | 'context';
}

export interface LiftedStep {
  /** The Inngest step ID, or the source text when it is not a literal. */
  stepId: string;
  /** True when the step ID was computed at runtime (template or variable). */
  dynamicId: boolean;
  functionName: string;
  line: number;
  /** The source call, e.g. `step.run` (Inngest) or `step.do` (Cloudflare). */
  source: string;
  /** Variables the closure read from the handler, now passed as arguments. */
  captured: CapturedVariable[];
  /** Number of extra inputs `step.run(id, fn, ...inputs)` passed. */
  inputs: number;
}

export interface FunctionTrigger {
  kind: 'event' | 'cron' | 'unknown';
  value: string;
}

export interface MigratedHook {
  line: number;
  /** The source wait this hook replaces, e.g. `step.waitForEvent`. */
  source: string;
  name: string;
  /** The token expression as written in the migrated code. */
  token: string;
  /** The same token built from the event the sender sends (`event`). */
  resumeToken?: string;
}

export interface MigratedFunction {
  /** The function's ID in the source framework, when it is a literal. */
  sourceId?: string;
  workflowName: string;
  line: number;
  triggers: FunctionTrigger[];
  steps: LiftedStep[];
  hooks: MigratedHook[];
  notes: MigrationNote[];
  /** Function-level config keys that need attention, e.g. `concurrency`. */
  config: Record<string, string>;
}

export interface AppBoundaryCall {
  line: number;
  /** e.g. `send`, `serve`, `sendSignal` (Inngest); `create`, `sendEvent` (Cloudflare). */
  kind: string;
  /** Event names, signals or bindings the call names, when literal. */
  names: string[];
  text: string;
}

export interface FileReport {
  file: string;
  changed: boolean;
  functions: MigratedFunction[];
  /** Notes that do not belong to one migrated function. */
  notes: MigrationNote[];
  boundary: AppBoundaryCall[];
}
