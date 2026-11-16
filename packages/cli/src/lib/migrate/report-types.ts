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
  /** The source construct, e.g. `step.run`, `step.ai.wrap`, `activity`. */
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
  /** The Inngest event or signal this hook replaces. */
  /** The source construct, e.g. `step.waitForEvent`, `signal`. */
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
  /** What the call does, e.g. `send`, `serve`, `start`, `signal`, `worker`. */
  kind: string;
  /** Event names (for `send`) or signal (for `sendSignal`), when literal. */
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
  /** Steps that belong to no workflow in this file (e.g. Temporal activities). */
  steps?: LiftedStep[];
}
