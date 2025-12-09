import { runInContext } from 'node:vm';
import { ERROR_SLUGS, WorkflowRuntimeError } from '@workflow/errors';
import { withResolvers } from '@workflow/utils';
import { getPort } from '@workflow/utils/get-port';
import type { Event, WorkflowRun } from '@workflow/world';
import * as nanoid from 'nanoid';
import { monotonicFactory } from 'ulid';
import { EventConsumerResult, EventsConsumer } from './events-consumer.js';
import { ENOTSUP } from './global.js';
import { parseWorkflowName } from './parse-name.js';
import type { WorkflowOrchestratorContext } from './private.js';
import {
  dehydrateWorkflowReturnValue,
  hydrateWorkflowArguments,
} from './serialization.js';
import { createUseStep } from './step.js';
import {
  BODY_INIT_SYMBOL,
  WORKFLOW_CREATE_HOOK,
  WORKFLOW_GET_STREAM_ID,
  WORKFLOW_SLEEP,
  WORKFLOW_USE_STEP,
} from './symbols.js';
import * as Attribute from './telemetry/semantic-conventions.js';
import { trace } from './telemetry.js';
import { getWorkflowRunStreamId } from './util.js';
import { createContext } from './vm/index.js';
import type { WorkflowMetadata } from './workflow/get-workflow-metadata.js';
import { WORKFLOW_CONTEXT_SYMBOL } from './workflow/get-workflow-metadata.js';
import { createCreateHook } from './workflow/hook.js';
import { createSleep } from './workflow/sleep.js';

export async function runWorkflow(
  workflowCode: string,
  workflowRun: WorkflowRun,
  events: Event[]
): Promise<unknown> {
  return trace(`WORKFLOW.run ${workflowRun.workflowName}`, async (span) => {
    span?.setAttributes({
      ...Attribute.WorkflowName(workflowRun.workflowName),
      ...Attribute.WorkflowRunId(workflowRun.runId),
      ...Attribute.WorkflowRunStatus(workflowRun.status),
      ...Attribute.WorkflowEventsCount(events.length),
    });

    const startedAt = workflowRun.startedAt;
    if (!startedAt) {
      throw new Error(
        `Workflow run "${workflowRun.runId}" has no "startedAt" timestamp (should not happen)`
      );
    }

    // Get the port before creating VM context to avoid async operations
    // affecting the deterministic timestamp
    const port = await getPort();

    const {
      context,
      globalThis: vmGlobalThis,
      updateTimestamp,
    } = createContext({
      seed: workflowRun.runId,
      fixedTimestamp: +startedAt,
    });

    const workflowDiscontinuation = withResolvers<void>();

    const ulid = monotonicFactory(() => vmGlobalThis.Math.random());
    const generateNanoid = nanoid.customRandom(nanoid.urlAlphabet, 21, (size) =>
      new Uint8Array(size).map(() => 256 * vmGlobalThis.Math.random())
    );

    const workflowContext: WorkflowOrchestratorContext = {
      globalThis: vmGlobalThis,
      onWorkflowError: workflowDiscontinuation.reject,
      eventsConsumer: new EventsConsumer(events),
      generateUlid: () => ulid(+startedAt),
      generateNanoid,
      invocationsQueue: new Map(),
    };

    // Subscribe to the events log to update the timestamp in the vm context
    workflowContext.eventsConsumer.subscribe((event) => {
      const createdAt = event?.createdAt;
      if (createdAt) {
        updateTimestamp(+createdAt);
      }
      // Never consume events - this is only a passive subscriber
      return EventConsumerResult.NotConsumed;
    });

    const useStep = createUseStep(workflowContext);
    const createHook = createCreateHook(workflowContext);
    const sleep = createSleep(workflowContext);

    // @ts-expect-error - `@types/node` says symbol is not valid, but it does work
    vmGlobalThis[WORKFLOW_USE_STEP] = useStep;
    // @ts-expect-error - `@types/node` says symbol is not valid, but it does work
    vmGlobalThis[WORKFLOW_CREATE_HOOK] = createHook;
    // @ts-expect-error - `@types/node` says symbol is not valid, but it does work
    vmGlobalThis[WORKFLOW_SLEEP] = sleep;
    // @ts-expect-error - `@types/node` says symbol is not valid, but it does work
    vmGlobalThis[WORKFLOW_GET_STREAM_ID] = (namespace?: string) =>
      getWorkflowRunStreamId(workflowRun.runId, namespace);

    // TODO: there should be a getUrl method on the world interface itself. This
    // solution only works for vercel + local worlds.
    const url = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : `http://localhost:${port ?? 3000}`;

    // For the workflow VM, we store the context in a symbol on the `globalThis` object
    const ctx: WorkflowMetadata = {
      workflowRunId: workflowRun.runId,
      workflowStartedAt: new vmGlobalThis.Date(+startedAt),
      url,
    };

    // @ts-expect-error - `@types/node` says symbol is not valid, but it does work
    vmGlobalThis[WORKFLOW_CONTEXT_SYMBOL] = ctx;

    // NOTE: Will have a config override to use the custom fetch step.
    //       For now `fetch` must be explicitly imported from `workflow`.
    vmGlobalThis.fetch = () => {
      throw new vmGlobalThis.Error(
        `Global "fetch" is unavailable in workflow functions. Use the "fetch" step function from "workflow" to make HTTP requests.\n\nLearn more: https://useworkflow.dev/err/${ERROR_SLUGS.FETCH_IN_WORKFLOW_FUNCTION}`
      );
    };

    // Override timeout/interval functions to throw helpful errors
    // These are not supported in workflow functions because they rely on
    // asynchronous scheduling which breaks deterministic replay
    const timeoutErrorMessage =
      'Timeout functions like "setTimeout" and "setInterval" are not supported in workflow functions. Use the "sleep" function from "workflow" for time-based delays.';

    (vmGlobalThis as any).setTimeout = () => {
      throw new WorkflowRuntimeError(timeoutErrorMessage, {
        slug: ERROR_SLUGS.TIMEOUT_FUNCTIONS_IN_WORKFLOW,
      });
    };
    (vmGlobalThis as any).setInterval = () => {
      throw new WorkflowRuntimeError(timeoutErrorMessage, {
        slug: ERROR_SLUGS.TIMEOUT_FUNCTIONS_IN_WORKFLOW,
      });
    };
    (vmGlobalThis as any).clearTimeout = () => {
      throw new WorkflowRuntimeError(timeoutErrorMessage, {
        slug: ERROR_SLUGS.TIMEOUT_FUNCTIONS_IN_WORKFLOW,
      });
    };
    (vmGlobalThis as any).clearInterval = () => {
      throw new WorkflowRuntimeError(timeoutErrorMessage, {
        slug: ERROR_SLUGS.TIMEOUT_FUNCTIONS_IN_WORKFLOW,
      });
    };
    (vmGlobalThis as any).setImmediate = () => {
      throw new WorkflowRuntimeError(timeoutErrorMessage, {
        slug: ERROR_SLUGS.TIMEOUT_FUNCTIONS_IN_WORKFLOW,
      });
    };
    (vmGlobalThis as any).clearImmediate = () => {
      throw new WorkflowRuntimeError(timeoutErrorMessage, {
        slug: ERROR_SLUGS.TIMEOUT_FUNCTIONS_IN_WORKFLOW,
      });
    };

    // `Request` and `Response` are special built-in classes that invoke steps
    // for the `json()`, `text()` and `arrayBuffer()` instance methods
    class Request implements globalThis.Request {
      cache!: globalThis.Request['cache'];
      credentials!: globalThis.Request['credentials'];
      destination!: globalThis.Request['destination'];
      headers!: Headers;
      integrity!: string;
      method!: string;
      mode!: globalThis.Request['mode'];
      redirect!: globalThis.Request['redirect'];
      referrer!: string;
      referrerPolicy!: globalThis.Request['referrerPolicy'];
      url!: string;
      keepalive!: boolean;
      signal!: AbortSignal;
      duplex!: 'half';
      body!: ReadableStream<any> | null;

      constructor(input: any, init?: RequestInit) {
        // Handle URL input
        if (typeof input === 'string' || input instanceof vmGlobalThis.URL) {
          const urlString = String(input);
          // Validate URL format
          try {
            new vmGlobalThis.URL(urlString);
            this.url = urlString;
          } catch (cause) {
            throw new TypeError(`Failed to parse URL from ${urlString}`, {
              cause,
            });
          }
        } else {
          // Input is a Request object - clone its properties
          this.url = input.url;
          if (!init) {
            this.method = input.method;
            this.headers = new vmGlobalThis.Headers(input.headers);
            this.body = input.body;
            this.mode = input.mode;
            this.credentials = input.credentials;
            this.cache = input.cache;
            this.redirect = input.redirect;
            this.referrer = input.referrer;
            this.referrerPolicy = input.referrerPolicy;
            this.integrity = input.integrity;
            this.keepalive = input.keepalive;
            this.signal = input.signal;
            this.duplex = input.duplex;
            this.destination = input.destination;
            return;
          }
          // If init is provided, merge: use source properties, then override with init
          // Copy all properties from the source Request first
          this.method = input.method;
          this.headers = new vmGlobalThis.Headers(input.headers);
          this.body = input.body;
          this.mode = input.mode;
          this.credentials = input.credentials;
          this.cache = input.cache;
          this.redirect = input.redirect;
          this.referrer = input.referrer;
          this.referrerPolicy = input.referrerPolicy;
          this.integrity = input.integrity;
          this.keepalive = input.keepalive;
          this.signal = input.signal;
          this.duplex = input.duplex;
          this.destination = input.destination;
        }

        // Override with init options if provided
        // Set method
        if (init?.method) {
          this.method = init.method.toUpperCase();
        } else if (typeof this.method !== 'string') {
          // Fallback to default for string input case
          this.method = 'GET';
        }

        // Set headers
        if (init?.headers) {
          this.headers = new vmGlobalThis.Headers(init.headers);
        } else if (
          typeof input === 'string' ||
          input instanceof vmGlobalThis.URL
        ) {
          // For string/URL input, create empty headers
          this.headers = new vmGlobalThis.Headers();
        }

        // Set other properties with init values or defaults
        if (init?.mode !== undefined) {
          this.mode = init.mode;
        } else if (typeof this.mode !== 'string') {
          this.mode = 'cors';
        }

        if (init?.credentials !== undefined) {
          this.credentials = init.credentials;
        } else if (typeof this.credentials !== 'string') {
          this.credentials = 'same-origin';
        }

        // `any` cast here because @types/node v22 does not yet have `cache`
        if ((init as any)?.cache !== undefined) {
          this.cache = (init as any).cache;
        } else if (typeof this.cache !== 'string') {
          this.cache = 'default';
        }

        if (init?.redirect !== undefined) {
          this.redirect = init.redirect;
        } else if (typeof this.redirect !== 'string') {
          this.redirect = 'follow';
        }

        if (init?.referrer !== undefined) {
          this.referrer = init.referrer;
        } else if (typeof this.referrer !== 'string') {
          this.referrer = 'about:client';
        }

        if (init?.referrerPolicy !== undefined) {
          this.referrerPolicy = init.referrerPolicy;
        } else if (typeof this.referrerPolicy !== 'string') {
          this.referrerPolicy = '';
        }

        if (init?.integrity !== undefined) {
          this.integrity = init.integrity;
        } else if (typeof this.integrity !== 'string') {
          this.integrity = '';
        }

        if (init?.keepalive !== undefined) {
          this.keepalive = init.keepalive;
        } else if (typeof this.keepalive !== 'boolean') {
          this.keepalive = false;
        }

        if (init?.signal !== undefined) {
          // @ts-expect-error - AbortSignal stub
          this.signal = init.signal;
        } else if (!this.signal) {
          // @ts-expect-error - AbortSignal stub
          this.signal = { aborted: false };
        }

        if (!this.duplex) {
          this.duplex = 'half';
        }

        if (!this.destination) {
          this.destination = 'document';
        }

        const body = init?.body;

        // Validate that GET/HEAD methods don't have a body
        if (
          body !== null &&
          body !== undefined &&
          (this.method === 'GET' || this.method === 'HEAD')
        ) {
          throw new TypeError(`Request with GET/HEAD method cannot have body.`);
        }

        // Store the original BodyInit for serialization
        if (body !== null && body !== undefined) {
          // Create a "fake" ReadableStream that stores the original body
          // This avoids doing async work during workflow replay
          this.body = Object.create(vmGlobalThis.ReadableStream.prototype, {
            [BODY_INIT_SYMBOL]: {
              value: body,
              writable: false,
            },
          });
        } else {
          this.body = null;
        }
      }

      clone(): Request {
        ENOTSUP();
      }

      get bodyUsed() {
        return false;
      }

      // TODO: implement these
      blob!: () => Promise<Blob>;
      formData!: () => Promise<FormData>;

      async arrayBuffer() {
        return resArrayBuffer(this);
      }

      async bytes() {
        return new Uint8Array(await resArrayBuffer(this));
      }

      async json() {
        return resJson(this);
      }

      async text() {
        return resText(this);
      }
    }
    vmGlobalThis.Request = Request;

    const resJson = useStep<[any], any>('__builtin_response_json');
    const resText = useStep<[any], string>('__builtin_response_text');
    const resArrayBuffer = useStep<[any], ArrayBuffer>(
      '__builtin_response_array_buffer'
    );
    class Response implements globalThis.Response {
      type!: globalThis.Response['type'];
      url!: string;
      status!: number;
      statusText!: string;
      body!: ReadableStream<Uint8Array> | null;
      headers!: Headers;
      redirected!: boolean;

      constructor(body?: any, init?: ResponseInit) {
        this.status = init?.status ?? 200;
        this.statusText = init?.statusText ?? '';
        this.headers = new vmGlobalThis.Headers(init?.headers);
        this.type = 'default';
        this.url = '';
        this.redirected = false;

        // Validate that null-body status codes don't have a body
        // Per HTTP spec: 204 (No Content), 205 (Reset Content), and 304 (Not Modified)
        if (
          body !== null &&
          body !== undefined &&
          (this.status === 204 || this.status === 205 || this.status === 304)
        ) {
          throw new TypeError(
            `Response constructor: Invalid response status code ${this.status}`
          );
        }

        // Store the original BodyInit for serialization
        if (body !== null && body !== undefined) {
          // Create a "fake" ReadableStream that stores the original body
          // This avoids doing async work during workflow replay
          this.body = Object.create(vmGlobalThis.ReadableStream.prototype, {
            [BODY_INIT_SYMBOL]: {
              value: body,
              writable: false,
            },
          });
        } else {
          this.body = null;
        }
      }

      // TODO: implement these
      clone!: () => Response;
      blob!: () => Promise<globalThis.Blob>;
      formData!: () => Promise<globalThis.FormData>;

      get ok() {
        return this.status >= 200 && this.status < 300;
      }

      get bodyUsed() {
        return false;
      }

      async arrayBuffer() {
        return resArrayBuffer(this);
      }

      async bytes() {
        return new Uint8Array(await resArrayBuffer(this));
      }

      async json() {
        return resJson(this);
      }

      static json(data: any, init?: ResponseInit): Response {
        const body = JSON.stringify(data);
        const headers = new vmGlobalThis.Headers(init?.headers);
        if (!headers.has('content-type')) {
          headers.set('content-type', 'application/json');
        }
        return new Response(body, { ...init, headers });
      }

      async text() {
        return resText(this);
      }

      static error(): Response {
        ENOTSUP();
      }

      static redirect(url: string | URL, status: number = 302): Response {
        // Validate status code - only specific redirect codes are allowed
        if (![301, 302, 303, 307, 308].includes(status)) {
          throw new RangeError(
            `Invalid redirect status code: ${status}. Must be one of: 301, 302, 303, 307, 308`
          );
        }

        // Create response with Location header
        const headers = new vmGlobalThis.Headers();
        headers.set('Location', String(url));

        const response = Object.create(Response.prototype);
        response.status = status;
        response.statusText = '';
        response.headers = headers;
        response.body = null;
        response.type = 'default';
        response.url = '';
        response.redirected = false;

        return response;
      }
    }
    vmGlobalThis.Response = Response;

    class ReadableStream<T> implements globalThis.ReadableStream<T> {
      constructor() {
        ENOTSUP();
      }

      get locked() {
        return false;
      }

      cancel(): any {
        ENOTSUP();
      }

      getReader(): any {
        ENOTSUP();
      }

      pipeThrough(): any {
        ENOTSUP();
      }

      pipeTo(): any {
        ENOTSUP();
      }

      tee(): any {
        ENOTSUP();
      }

      values(): any {
        ENOTSUP();
      }

      static from(): any {
        ENOTSUP();
      }

      [Symbol.asyncIterator](): any {
        ENOTSUP();
      }
    }
    vmGlobalThis.ReadableStream = ReadableStream;

    class WritableStream<T> implements globalThis.WritableStream<T> {
      constructor() {
        ENOTSUP();
      }

      get locked() {
        return false;
      }

      abort(): any {
        ENOTSUP();
      }

      close(): any {
        ENOTSUP();
      }

      getWriter(): any {
        ENOTSUP();
      }
    }
    vmGlobalThis.WritableStream = WritableStream;

    class TransformStream<I, O> implements globalThis.TransformStream<I, O> {
      readable: globalThis.ReadableStream<O>;
      writable: globalThis.WritableStream<I>;

      constructor() {
        ENOTSUP();
      }
    }
    vmGlobalThis.TransformStream = TransformStream;

    // Eventually we'll probably want to provide our own `console` object,
    // but for now we'll just expose the global one.
    vmGlobalThis.console = globalThis.console;

    // HACK: propagate symbol needed for AI gateway usage
    const SYMBOL_FOR_REQ_CONTEXT = Symbol.for('@vercel/request-context');
    // @ts-expect-error - `@types/node` says symbol is not valid, but it does work
    vmGlobalThis[SYMBOL_FOR_REQ_CONTEXT] = (globalThis as any)[
      SYMBOL_FOR_REQ_CONTEXT
    ];

    // Get a reference to the user-defined workflow function.
    // The filename parameter ensures stack traces show a meaningful name
    // (e.g., "example/workflows/99_e2e.ts") instead of "evalmachine.<anonymous>".
    const parsedName = parseWorkflowName(workflowRun.workflowName);
    const filename = parsedName?.path || workflowRun.workflowName;

    const workflowFn = runInContext(
      `${workflowCode}; globalThis.__private_workflows?.get(${JSON.stringify(workflowRun.workflowName)})`,
      context,
      { filename }
    );

    if (typeof workflowFn !== 'function') {
      throw new ReferenceError(
        `Workflow ${JSON.stringify(
          workflowRun.workflowName
        )} must be a function, but got "${typeof workflowFn}" instead`
      );
    }

    const args = hydrateWorkflowArguments(workflowRun.input, vmGlobalThis);

    span?.setAttributes({
      ...Attribute.WorkflowArgumentsCount(args.length),
    });

    // Invoke user workflow
    const result = await Promise.race([
      workflowFn(...args),
      workflowDiscontinuation.promise,
    ]);

    const dehydrated = dehydrateWorkflowReturnValue(result, vmGlobalThis);

    span?.setAttributes({
      ...Attribute.WorkflowResultType(typeof result),
    });

    return dehydrated;
  });
}
