// Minimal ambient declarations for the Workers runtime APIs this POC uses.
// Kept local so the package does not need @cloudflare/workers-types.

declare module 'cloudflare:workers' {
  export const env: Record<string, unknown>;

  export interface DurableObjectStub {
    [method: string]: (...args: any[]) => Promise<any>;
  }

  export interface DurableObjectNamespace {
    idFromName(name: string): unknown;
    get(id: unknown): DurableObjectStub;
    getByName(name: string): DurableObjectStub;
  }

  export interface SyncKvStorage {
    get<T = unknown>(key: string): T | undefined;
    put<T>(key: string, value: T): void;
    delete(key: string): boolean;
    list<T = unknown>(options?: {
      prefix?: string;
      start?: string;
      startAfter?: string;
      end?: string;
      limit?: number;
      reverse?: boolean;
    }): Iterable<[string, T]>;
  }

  export interface DurableObjectStorage {
    kv: SyncKvStorage;
    transactionSync<T>(fn: () => T): T;
    getAlarm(): Promise<number | null>;
    setAlarm(scheduledTime: number | Date): Promise<void>;
    deleteAlarm(): Promise<void>;
    sync(): Promise<void>;
    deleteAll(): Promise<void>;
  }

  export interface DurableObjectState {
    id: { toString(): string; name?: string };
    storage: DurableObjectStorage;
    exports: Record<string, any>;
    waitUntil(promise: Promise<unknown>): void;
    blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
    abort(reason?: string): void;
  }

  export abstract class DurableObject<Env = unknown> {
    protected ctx: DurableObjectState;
    protected env: Env;
    constructor(ctx: DurableObjectState, env: Env);
  }

  export interface ExecutionContext {
    waitUntil(promise: Promise<unknown>): void;
    exports: Record<string, any>;
  }

  export abstract class WorkerEntrypoint<Env = unknown> {
    protected ctx: ExecutionContext;
    protected env: Env;
    constructor(ctx: ExecutionContext, env: Env);
  }
}
