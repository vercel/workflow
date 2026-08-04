/**
 * QuickJS WASM workflow VM.
 *
 * An alternative engine for the event-replay execution model: the workflow
 * code runs inside a QuickJS WASM VM (via quickjs-wasi) instead of a
 * `node:vm` context. Every invocation creates a fresh VM, re-executes the
 * workflow function from the top, and replays the recorded event log to
 * resolve awaited primitives — the same replay semantics as the `node:vm`
 * engine.
 *
 * The workflow primitives (useStep, sleep, createHook) are implemented as
 * JavaScript code running inside the QuickJS VM. The host communicates with
 * the VM by evaluating small JS snippets to read pending operations and
 * resolve/reject promises.
 *
 * The VM bootstrap is deliberately split into two phases:
 *   1. Static initialization (`initWorkflowVM`) — run-independent setup:
 *      VM creation and the workflow primitives. (Serialization lives on
 *      the host — see quickjs-serde.ts — so no serde code is evaluated
 *      in the VM.)
 *   2. Per-run initialization (inline in `runQuickJSWorkflow`) — seeded
 *      PRNG/ULID host functions, workflow bundle evaluation, run metadata,
 *      workflow input, and start.
 * Keeping the phases separate is groundwork for VM-memory snapshotting:
 * a follow-up can persist/restore the VM at the phase boundary (e.g. a
 * build-time initial snapshot) without restructuring this module. Note
 * that bundle evaluation currently sits in the per-run phase so that
 * module-scope user code observes the seeded `Math.random`, matching the
 * `node:vm` engine's replay determinism.
 */

import type { Event, RunInput, WorkflowRun } from '@workflow/world';
import * as nanoid from 'nanoid';
import {
  type ExtensionDescriptor,
  JSException,
  QuickJS,
  type WasiOptions,
} from 'quickjs-wasi';
import seedrandom from 'seedrandom';
import { monotonicFactory } from 'ulid';
import { runtimeLogger } from '../logger.js';
import { decompress } from '../serialization/compression.js';
import type { DecryptionKey } from '../serialization/encryption.js';
import { decrypt } from '../serialization/encryption.js';
import { getReplayTimeoutMs } from './constants.js';
import { quickjsExtensions, quickjsWasm } from './quickjs-assets.generated.js';
import { createQuickJSSerde, type QuickJSSerde } from './quickjs-serde.js';
import { runIdCreatedAt } from './run-id-time.js';

// ---- Host -> VM payload preparation ----

/**
 * Prepare persisted payload bytes for consumption inside the VM: decrypt
 * (when an encryption key is configured) and decompress (specVersion >= 5
 * payloads may be gzip/zstd-compressed). The VM only understands plain
 * format-prefixed 'devl' bytes — it has neither the key material nor zlib.
 * The key is the run's full DecryptionKey capability (symmetric AES key +
 * X25519 keypair) so sealed `encp` hook payloads from cross-deployment
 * resumeHook() calls open here too, not just symmetric `encr` ones.
 * Both stages are format-prefix dispatched, so plaintext/uncompressed
 * data passes through unchanged. Mirrors `prepareReplayPayload` in
 * serialization.ts (the node:vm engine's equivalent host-side stage).
 */
async function prepareBytesForVM(
  data: Uint8Array,
  key?: DecryptionKey
): Promise<Uint8Array> {
  return (await decompress(await decrypt(data, key))) as Uint8Array;
}

// ---- Types ----

export interface PendingStep {
  type: 'step';
  correlationId: string;
  stepId: string;
  /** Format-prefixed devalue-serialized step input (args + closureVars) */
  input: Uint8Array;
  /** Whether a step_created event already exists for this step */
  hasCreatedEvent: boolean;
}

export interface PendingWait {
  type: 'wait';
  correlationId: string;
  /** ISO string of when to resume */
  resumeAt: string;
  /** Whether a wait_created event already exists for this wait */
  hasCreatedEvent: boolean;
}

export interface PendingHook {
  type: 'hook';
  correlationId: string;
  token: string;
  /** Earliest token reuse time, as milliseconds since the Unix epoch. */
  tokenRetentionUntil?: number;
  isWebhook: boolean;
  metadata?: unknown;
  hasCreatedEvent: boolean;
  /**
   * True for internal system hooks (e.g. AbortController's hook), which
   * are exempt from user-hook token namespace conflict checks.
   */
  isSystem?: boolean;
  /**
   * Set when the workflow called AbortController.abort() during this
   * invocation. The host must record the abort: create a hook_received
   * event carrying `abortPayload` and write/close the abort stream.
   */
  abortRequested?: boolean;
  /** VM-serialized `{ aborted: true, reason }` payload for the abort. */
  abortPayload?: Uint8Array;
  /** Set by the completion drain when a system hook is implicitly disposed. */
  disposed?: boolean;
  /**
   * True when the workflow is awaiting hook.getConflict() for this hook.
   * The entrypoint re-invokes the workflow right after writing
   * hook_created so replay can confirm creation and resolve the awaiter.
   */
  hasGetConflictAwaiter?: boolean;
}

export interface PendingAttribute {
  type: 'attribute';
  correlationId: string;
  /** Normalized attribute changes (plain JSON-able objects) */
  changes: unknown[];
  allowReservedAttributes?: boolean;
  /** Whether an attr_set event already exists for this write */
  hasCreatedEvent: boolean;
}

export interface PendingHookDispose {
  type: 'hook_dispose';
  correlationId: string;
  /**
   * Token of the hook being disposed. Used by the entrypoint to order
   * same-token hook operations sequentially in code order.
   */
  token?: string;
  hasCreatedEvent: boolean;
}

export type PendingOperation =
  | PendingStep
  | PendingWait
  | PendingHook
  | PendingAttribute
  | PendingHookDispose;

export interface QuickJSRuntimeResult {
  /** The workflow completed — result is format-prefixed devalue bytes */
  completed?: {
    result: Uint8Array;
    /**
     * Leftover pending operations that still need durable side effects at
     * completion: abort recordings, system-hook disposals, fire-and-forget
     * attribute/hook/step events. Mirrors the node:vm engine's
     * drainPendingQueueItems. The entrypoint dispatches these WITHOUT
     * queueing steps or requeuing the run.
     */
    drainOperations?: PendingOperation[];
  };
  /** The workflow suspended with pending operations */
  suspended?: {
    pendingOperations: PendingOperation[];
  };
  /** The workflow failed */
  failed?: {
    message: string;
    stack?: string;
    name?: string;
    /** See completed.drainOperations — same semantics on failure. */
    drainOperations?: PendingOperation[];
    /**
     * Format-prefixed devalue bytes of the original thrown value
     * (Error subclass with cause chain, plain object, primitive, etc.).
     * Set when the VM-side rejection handler successfully serializes
     * the thrown value. The host uses these bytes to reconstruct the
     * original value through the standard error hydration pipeline,
     * preserving type identity (TypeError, FatalError) and non-Error
     * throws verbatim. Falls back to the message/stack/name fields
     * when this is undefined (e.g. extractError pseudo-failures).
     */
    valueBytes?: Uint8Array;
  };
}

export interface QuickJSRuntimeOptions {
  /** The compiled workflow bundle code (workflow mode output from SWC) */
  workflowCode: string;
  /** The workflow ID (e.g. "workflow//./workflows/1_simple//simple") */
  workflowId: string;
  /** The workflow run entity */
  workflowRun: WorkflowRun;
  /**
   * The full event log for the run. Every invocation replays the complete
   * log from the start (same replay semantics as the `node:vm` engine).
   */
  events: Event[];
  /** Encryption key for decrypting event payloads (undefined if unencrypted) */
  encryptionKey?: DecryptionKey;
  /**
   * The local port the workflow server is listening on, used to populate
   * `workflowMetadata.url`. Resolved at call time on the host side so the
   * VM doesn't have to probe the filesystem. Ignored on Vercel — VERCEL_URL
   * takes precedence there.
   */
  port?: number;
  /**
   * Fallback workflow input from the queue message's resilient-start
   * payload. Used when the fetched event log lacks a `run_created` event
   * (eventually-consistent read after the parent's start() wrote it).
   */
  runInput?: RunInput;
}

// ---- VM Bootstrap Code ----

/**
 * JavaScript code that runs inside the QuickJS VM to set up the workflow
 * primitives. This sets up:
 * - globalThis.__private_workflows (Map) - workflow registry
 * - globalThis.__resolvers (Object) - pending promise resolve/reject functions
 * - globalThis.__pending (Array) - metadata about pending operations
 * - globalThis[Symbol.for("WORKFLOW_USE_STEP")] - step proxy factory
 * - globalThis[Symbol.for("WORKFLOW_SLEEP")] - sleep function
 */
const VM_BOOTSTRAP = `
// Symbol.dispose / Symbol.asyncDispose polyfills for QuickJS
if (typeof Symbol.dispose === "undefined") {
  Symbol.dispose = Symbol.for("Symbol.dispose");
}
if (typeof Symbol.asyncDispose === "undefined") {
  Symbol.asyncDispose = Symbol.for("Symbol.asyncDispose");
}

globalThis.__private_workflows = new Map();
globalThis.__resolvers = {};
globalThis.__pending = [];
globalThis.__workflowResult = undefined;
globalThis.__workflowError = undefined;
// Buffer for hook_received payloads that arrive before the hook is awaited.
// Keyed by correlationId → array of payloads (preserves delivery order).
// This mirrors the event-replay runtime's payloadsQueue in hook.ts.
globalThis.__hookPayloadBuffer = {};

// Buffer for step/wait/attr terminal outcomes that arrive before this VM
// has constructed the corresponding awaiting promise. In fresh-VM replay
// the multi-pass event scan makes this unreachable (awaits are
// reconstructed before their terminals are re-scanned), but the live
// continuation path (continueWithEvents) scans each delta exactly once —
// a concurrent invocation's terminal arriving before this VM reaches the
// await would otherwise be dropped on the floor and the await would
// never settle (the feed's seen-set means it is never re-delivered).
// Mirrors __hookPayloadBuffer, which exists for exactly this reason on
// the hook path. Keyed by correlationId → single terminal (steps, waits
// and attrs settle exactly once).
globalThis.__terminalBuffer = {};

// Registers a resolver for an awaited primitive, first draining any
// buffered terminal recorded for the correlationId. Entries are prepared
// host-side: bytes are decrypted AND deserialized into VM values by the
// host serde before buffering (the VM has no in-guest deserializer on
// the host-serde engine), so draining only forwards the stored value.
globalThis.__registerResolver = function(correlationId, resolve, reject) {
  var buffered = globalThis.__terminalBuffer[correlationId];
  if (buffered) {
    delete globalThis.__terminalBuffer[correlationId];
    if (buffered.kind === "resolve_value") {
      resolve(buffered.value);
    } else if (buffered.kind === "reject_value") {
      reject(buffered.value);
    } else if (buffered.kind === "reject_error") {
      var e = new Error(buffered.message);
      e.name = "FatalError";
      e.fatal = true;
      if (buffered.stack) e.stack = buffered.stack;
      reject(e);
    } else {
      resolve(undefined);
    }
    return;
  }
  globalThis.__resolvers[correlationId] = { resolve: resolve, reject: reject };
};

// Stubs for Web APIs that the workflow bundle may reference but are not
// available in QuickJS. Native C extensions (encoding, headers, url,
// structured-clone) provide the real implementations; these are minimal
// stubs for APIs that don't have native extensions yet. (btoa/atob and
// the Uint8Array base64/hex methods are built into quickjs-wasi >= 3.)

if (typeof ReadableStream === "undefined") {
  // Minimal ReadableStream that stores body data for Response.json()/text()
  globalThis.ReadableStream = function() {};
  globalThis.ReadableStream.prototype.__bodyData = null;
}

if (typeof WritableStream === "undefined") {
  globalThis.WritableStream = function() {};
}

if (typeof TransformStream === "undefined") {
  globalThis.TransformStream = function() {};
}

if (typeof console === "undefined") {
  globalThis.console = { log: function(){}, error: function(){}, warn: function(){}, info: function(){} };
}
// Stub exports/module for CJS bundle format
globalThis.exports = {};
globalThis.module = { exports: globalThis.exports };
// NOTE: TextEncoder/TextDecoder are provided by the native encoding extension.

// ---- Deterministic \`crypto\` (parity with the node:vm engine) ----
// getRandomValues / randomUUID draw from Math.random, which the host
// replaces with the run's seeded PRNG before any user code runs — so the
// values replay deterministically and match the node engine, whose
// implementations draw from the same seeded sequence (see vm/index.ts).
// Every crypto.subtle method throws with the same guidance as the node
// engine's non-replayable methods; unlike node, \`digest\` is also
// unavailable here (no native hash in the VM yet).
(function() {
  function getRandomValues(array) {
    for (var i = 0; i < array.length; i++) {
      array[i] = Math.floor(Math.random() * 256);
    }
    return array;
  }
  // Mirrors vm/uuid.ts createRandomUUID: identical draw pattern from the
  // seeded PRNG, so both engines produce the same UUID at the same point
  // in a replay.
  function randomUUID() {
    var chars = "0123456789abcdef";
    var uuid = "";
    for (var i = 0; i < 36; i++) {
      if (i === 8 || i === 13 || i === 18 || i === 23) {
        uuid += "-";
      } else if (i === 14) {
        uuid += "4";
      } else if (i === 19) {
        uuid += chars[Math.floor(Math.random() * 4) + 8];
      } else {
        uuid += chars[Math.floor(Math.random() * 16)];
      }
    }
    return uuid;
  }
  function subtleThrow(name) {
    return function() {
      var err = new Error("\`crypto.subtle." + name + "()\` is not available inside a workflow function. Move it to a step function where full Node.js crypto is available.");
      err.name = "WorkflowRuntimeError";
      throw err;
    };
  }
  var subtle = {};
  ["encrypt","decrypt","sign","verify","digest","generateKey","deriveKey","deriveBits","importKey","exportKey","wrapKey","unwrapKey"].forEach(function(m) {
    subtle[m] = subtleThrow(m);
  });
  globalThis.crypto = {
    getRandomValues: getRandomValues,
    randomUUID: randomUUID,
    subtle: subtle,
  };
})();

// ---- Loud Intl / locale guards ----
// QuickJS has no ICU: \`Intl\` is absent and toLocaleString-family methods
// silently ignore their locale argument. Silent divergence from the node
// engine would write different values into a durable event log with no
// error anywhere — so make the gap loud instead: Intl constructors throw,
// and toLocale* methods throw ONLY when called with an explicit locale
// (the no-argument forms keep QuickJS's default behavior).
(function() {
  function intlThrow(name) {
    return function() {
      var err = new Error("\`Intl." + name + "\` is not available in the QuickJS workflow engine (no ICU). Perform locale-sensitive formatting in a step function, or use WORKFLOW_VM=node.");
      err.name = "WorkflowRuntimeError";
      throw err;
    };
  }
  if (typeof Intl === "undefined") {
    var intl = {};
    ["Collator","DateTimeFormat","DisplayNames","DurationFormat","ListFormat","Locale","NumberFormat","PluralRules","RelativeTimeFormat","Segmenter"].forEach(function(n) {
      intl[n] = intlThrow(n);
    });
    intl.getCanonicalLocales = intlThrow("getCanonicalLocales");
    globalThis.Intl = intl;
  }
  function guardLocale(proto, method) {
    var original = proto[method];
    if (typeof original !== "function") return;
    proto[method] = function(locales) {
      if (locales !== undefined) {
        var err = new Error("\`" + method + "(locales, ...)\` with an explicit locale is not supported in the QuickJS workflow engine (no ICU) — it would silently ignore the locale. Format in a step function, or call without arguments for the engine default.");
        err.name = "WorkflowRuntimeError";
        throw err;
      }
      return original.call(this);
    };
  }
  guardLocale(Number.prototype, "toLocaleString");
  guardLocale(Date.prototype, "toLocaleString");
  guardLocale(Date.prototype, "toLocaleDateString");
  guardLocale(Date.prototype, "toLocaleTimeString");
  guardLocale(String.prototype, "toLocaleLowerCase");
  guardLocale(String.prototype, "toLocaleUpperCase");
  // localeCompare's locales argument is the SECOND parameter.
  (function() {
    var original = String.prototype.localeCompare;
    String.prototype.localeCompare = function(that, locales) {
      if (locales !== undefined) {
        var err = new Error("\`localeCompare(that, locales, ...)\` with an explicit locale is not supported in the QuickJS workflow engine (no ICU). Compare in a step function, or call without a locale.");
        err.name = "WorkflowRuntimeError";
        throw err;
      }
      return original.call(this, that);
    };
  })();
})();

globalThis[Symbol.for("WORKFLOW_USE_STEP")] = function(stepId, closureVarsFn) {
  var fn = function() {
    var args = Array.prototype.slice.call(arguments);
    var correlationId = "step_" + globalThis.__generateUlid();
    // Capture 'this' for method invocations (e.g., MyClass.method())
    var thisVal = (this !== undefined && this !== null && this !== globalThis) ? this : undefined;
    // The RAW input value. Serialization happens on the host, which reads
    // this through a handle when it collects the pending op — no
    // serializer code runs inside the VM.
    var input = {
      args: args,
      closureVars: closureVarsFn ? closureVarsFn() : undefined,
      thisVal: thisVal,
    };
    globalThis.__pending.push({
      type: "step",
      correlationId: correlationId,
      stepId: stepId,
      input: input,
      hasCreatedEvent: false,
    });
    return new Promise(function(resolve, reject) {
      globalThis.__registerResolver(correlationId, resolve, reject);
    });
  };
  // Set stepId on the proxy so the StepFunction reducer can detect and
  // serialize step function references (e.g. when passed as arguments).
  fn.stepId = stepId;
  if (closureVarsFn) fn.__closureVarsFn = closureVarsFn;
  // Override .bind so a bound step proxy (e.g. the SWC plugin's
  // useStep(...).bind(this) for lexical-this arrow steps) keeps its
  // stepId and records the bound receiver / prefilled args — the native
  // bind drops own properties, which would make the StepFunction
  // reducer fail to recognize the proxy when it crosses a serialization
  // boundary. Mirrors the node:vm engine's override in step.ts.
  fn.bind = function(thisArg) {
    var partialArgs = Array.prototype.slice.call(arguments, 1);
    var bound = Function.prototype.bind.apply(this, [thisArg].concat(partialArgs));
    bound.stepId = stepId;
    if (closureVarsFn) bound.__closureVarsFn = closureVarsFn;
    bound.__boundThis = thisArg;
    if (partialArgs.length > 0) bound.__boundArgs = partialArgs;
    return bound;
  };
  return fn;
};

// Parses an "ms" library style duration string into milliseconds.
// Supports the same units as the replay runtime (which uses the "ms"
// package): ms / s / m / h / d / w / y, with verbose aliases
// (seconds, minutes, ...).
globalThis.__parseDurationMs = function(str) {
  str = String(str);
  if (str.length > 100) return undefined;
  var match = str.match(
    /^(-?(?:\\d+)?\\.?\\d+) *(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|years?|yrs?|y)?$/i
  );
  if (!match) return undefined;
  var n = parseFloat(match[1]);
  var type = (match[2] || "ms").toLowerCase();
  var s = 1000, m = 60 * s, h = 60 * m, d = 24 * h, w = 7 * d, y = 365.25 * d;
  switch (type) {
    case "years": case "year": case "yrs": case "yr": case "y": return n * y;
    case "weeks": case "week": case "w": return n * w;
    case "days": case "day": case "d": return n * d;
    case "hours": case "hour": case "hrs": case "hr": case "h": return n * h;
    case "minutes": case "minute": case "mins": case "min": case "m": return n * m;
    case "seconds": case "second": case "secs": case "sec": case "s": return n * s;
    case "milliseconds": case "millisecond": case "msecs": case "msec": case "ms": return n;
    default: return undefined;
  }
};

globalThis[Symbol.for("WORKFLOW_SLEEP")] = function(param) {
  var correlationId = "wait_" + globalThis.__generateUlid();
  var resumeAt;
  if (typeof param === "number") {
    resumeAt = new Date(Date.now() + param).toISOString();
  } else if (typeof param === "string") {
    var ms = globalThis.__parseDurationMs(param);
    if (typeof ms === "number" && isFinite(ms)) {
      resumeAt = new Date(Date.now() + ms).toISOString();
    } else {
      // Not a duration string — try as an absolute date string.
      var date = new Date(param);
      if (isNaN(date.getTime())) {
        throw new Error("Invalid sleep parameter: " + param);
      }
      resumeAt = date.toISOString();
    }
  } else if (param instanceof Date) {
    if (isNaN(param.getTime())) {
      throw new Error("Invalid sleep parameter: " + param);
    }
    resumeAt = param.toISOString();
  } else {
    throw new Error("Invalid sleep parameter: " + param);
  }
  globalThis.__pending.push({
    type: "wait",
    correlationId: correlationId,
    resumeAt: resumeAt,
    hasCreatedEvent: false,
  });
  return new Promise(function(resolve, reject) {
    globalThis.__registerResolver(correlationId, resolve, reject);
  });
};

// Response/Request polyfills — .json()/.text()/.arrayBuffer() are useStep
// proxies that execute on the host side. The proxies are assigned directly
// to the prototypes so that 'this' (the Response/Request instance) is
// serialized as thisVal by WORKFLOW_USE_STEP, matching the event-replay
// runtime's approach (commit dcb0761).
if (typeof Response === "undefined") {
  var __BODY_INIT = Symbol.for("BODY_INIT");

  globalThis.Response = function(body, init) {
    init = init || {};
    this.status = init.status || 200;
    this.statusText = init.statusText || "";
    this.headers = new globalThis.Headers(init.headers || []);
    this.type = "default";
    this.url = "";
    this.redirected = false;
    if (body !== null && body !== undefined) {
      this.body = Object.create(globalThis.ReadableStream.prototype);
      this.body[__BODY_INIT] = body;
    } else {
      this.body = null;
    }
  };
  Object.defineProperty(globalThis.Response.prototype, "ok", {
    get: function() { return this.status >= 200 && this.status < 300; }
  });
  Object.defineProperty(globalThis.Response.prototype, "bodyUsed", {
    get: function() { return false; }
  });
  // Assign useStep proxies directly — 'this' binding provides the
  // Response instance, which gets serialized as thisVal by the proxy.
  Object.defineProperties(globalThis.Response.prototype, {
    arrayBuffer: { value: globalThis[Symbol.for("WORKFLOW_USE_STEP")]("__builtin_response_array_buffer"), writable: true, configurable: true },
    json: { value: globalThis[Symbol.for("WORKFLOW_USE_STEP")]("__builtin_response_json"), writable: true, configurable: true },
    text: { value: globalThis[Symbol.for("WORKFLOW_USE_STEP")]("__builtin_response_text"), writable: true, configurable: true },
  });
  globalThis.Response.prototype.bytes = function() {
    return this.arrayBuffer().then(function(buf) { return new Uint8Array(buf); });
  };
  globalThis.Response.prototype.clone = function() {
    var r = Object.create(globalThis.Response.prototype);
    r.status = this.status; r.statusText = this.statusText;
    r.headers = this.headers; r.type = this.type;
    r.url = this.url; r.redirected = this.redirected; r.body = this.body;
    return r;
  };
  globalThis.Response.json = function(data, init) {
    var body = JSON.stringify(data);
    var headers = new globalThis.Headers(init ? init.headers : []);
    if (!headers.has("content-type")) { headers.set("content-type", "application/json"); }
    return new globalThis.Response(body, { status: (init && init.status) || 200, statusText: (init && init.statusText) || "", headers: headers });
  };
}
if (typeof Request === "undefined") {
  globalThis.Request = function(input, init) {
    init = init || {};
    if (typeof input === "string") { this.url = input; }
    else if (input && typeof input === "object") {
      this.url = input.url || ""; this.method = input.method;
      this.headers = input.headers; this.body = input.body;
    }
    if (init.method) this.method = init.method.toUpperCase();
    if (!this.method) this.method = "GET";
    if (init.headers) this.headers = new globalThis.Headers(init.headers);
    if (!this.headers) this.headers = new globalThis.Headers();
    if (init.body !== undefined) this.body = init.body;
    if (!this.body) this.body = null;
    this.duplex = init.duplex || "half";
  };
  Object.defineProperty(globalThis.Request.prototype, "bodyUsed", {
    get: function() { return false; }
  });
  Object.defineProperties(globalThis.Request.prototype, {
    arrayBuffer: { value: globalThis[Symbol.for("WORKFLOW_USE_STEP")]("__builtin_response_array_buffer"), writable: true, configurable: true },
    json: { value: globalThis[Symbol.for("WORKFLOW_USE_STEP")]("__builtin_response_json"), writable: true, configurable: true },
    text: { value: globalThis[Symbol.for("WORKFLOW_USE_STEP")]("__builtin_response_text"), writable: true, configurable: true },
  });
}

// createHook — returns a Hook object that is both a Thenable and AsyncIterable.
// Each await/yield creates a new promise keyed by the same correlationId.
// The promise is resolved when a hook_received event arrives.
globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")] = function(options) {
  options = options || {};
  if (options.isWebhook === true && options.experimental_minRetention !== undefined) {
    throw new Error('Webhook hooks do not support \`experimental_minRetention\`. Use a non-webhook \`createHook()\` with \`resumeHook()\`.');
  }
  var token = options.token || globalThis.__generateNanoid();
  var correlationId = "hook_" + globalThis.__generateUlid();
  var isDisposed = false;
  var hasCreatedEvent = false;
  var tokenRetentionUntil;
  if (options.experimental_minRetention !== undefined) {
    var minRetention = options.experimental_minRetention;
    if (typeof minRetention === "number") {
      if (minRetention < 0 || !isFinite(minRetention)) {
        throw new Error("Invalid duration: " + minRetention + ". Expected a non-negative finite number of milliseconds.");
      }
      tokenRetentionUntil = Date.now() + minRetention;
    } else if (typeof minRetention === "string") {
      var retentionMs = globalThis.__parseDurationMs(minRetention);
      if (typeof retentionMs !== "number" || retentionMs < 0 || !isFinite(retentionMs)) {
        throw new Error('Invalid duration: "' + minRetention + '". Expected a valid duration string like "1s", "1m", "1h", etc.');
      }
      tokenRetentionUntil = Date.now() + retentionMs;
    } else if (minRetention instanceof Date || (minRetention && typeof minRetention.getTime === "function")) {
      // Accept Date-like objects (anything with getTime), matching
      // parseDurationToDate: values that crossed the serde boundary may
      // not be realm-native Date instances.
      tokenRetentionUntil = minRetention.getTime();
    } else {
      throw new Error("Invalid duration parameter. Expected a duration string, number (milliseconds), or Date object.");
    }
  }

  // Register in pending operations. Metadata stays a RAW value; the host
  // serializes it through a handle when it collects the pending op.
  var pendingOp = {
    type: "hook",
    correlationId: correlationId,
    token: token,
    tokenRetentionUntil: tokenRetentionUntil,
    isWebhook: !!options.isWebhook,
    metadata: options.metadata,
    hasCreatedEvent: false,
  };
  globalThis.__pending.push(pendingOp);

  // Per-hook lifecycle state backing hook.getConflict(): resolves null
  // once creation is confirmed (hook_created), or resolves with the
  // conflicting Run handle / rejects with HookConflictError on
  // hook_conflict. State transitions are driven by the host during event
  // processing (see processEvents).
  globalThis.__hooks = globalThis.__hooks || {};
  globalThis.__hooks[correlationId] = {
    token: token,
    created: false,
    conflict: null,
    getConflictResolvers: [],
  };

  // Each await creates a new promise for the next payload.
  // The correlationId stays the same — the resolver is replaced each time.
  function createHookPromise() {
    // Check the payload buffer first — if a hook_received event arrived
    // before this hook was awaited, the payload was buffered in the VM
    // heap. Drain it immediately (matching event-replay payloadsQueue).
    var buf = globalThis.__hookPayloadBuffer[correlationId];
    if (buf && buf.length > 0) {
      return Promise.resolve(buf.shift());
    }
    return new Promise(function(resolve, reject) {
      globalThis.__resolvers[correlationId] = { resolve: resolve, reject: reject };
    });
  }

  function disposeHook() {
    if (isDisposed) return;
    isDisposed = true;
    // A conflicted hook was never created (the world rejected its claim
    // — the token belongs to another run), so there is no entity to
    // dispose. Mirrors the node:vm engine, where hook_conflict removes
    // the invocation-queue item before dispose can mark it. Emitting a
    // hook_disposed here would be rejected by the world's
    // hook-existence validation.
    var state = globalThis.__hooks[correlationId];
    if (!state || !state.conflict) {
      // Signal to the entrypoint to create a hook_disposed event. The
      // token is carried so the entrypoint can order same-token hook
      // operations sequentially (a dispose must release the token before
      // a later same-token hook's creation is validated).
      globalThis.__pending.push({
        type: "hook_dispose",
        correlationId: correlationId,
        token: token,
        hasCreatedEvent: false,
      });
    }
    // If there's a pending resolver, resolve it with undefined to break the iterator
    if (globalThis.__resolvers[correlationId]) {
      globalThis.__resolvers[correlationId].resolve(undefined);
      delete globalThis.__resolvers[correlationId];
    }
  }

  function getConflict() {
    var state = globalThis.__hooks[correlationId];
    if (state.conflict) {
      return state.conflict.run
        ? Promise.resolve(state.conflict.run)
        : Promise.reject(state.conflict.error);
    }
    if (state.created) {
      return Promise.resolve(null);
    }
    // Creation not yet confirmed by the event log — park the awaiter and
    // flag the pending op so the entrypoint re-invokes the workflow right
    // after writing hook_created (nothing external resumes a getConflict
    // awaiter; confirmation only comes from replaying the new event).
    pendingOp.hasGetConflictAwaiter = true;
    return new Promise(function(resolve, reject) {
      state.getConflictResolvers.push({ resolve: resolve, reject: reject });
    });
  }

  var hook = {
    token: token,
    then: function(onFulfilled, onRejected) {
      return createHookPromise().then(onFulfilled, onRejected);
    },
    getConflict: getConflict,
    dispose: disposeHook,
  };

  // Symbol.dispose for explicit resource management
  hook[Symbol.dispose] = disposeHook;

  // AsyncIterable — yields payloads until disposed
  hook[Symbol.asyncIterator] = function() {
    return {
      next: function() {
        if (isDisposed) {
          return Promise.resolve({ done: true, value: undefined });
        }
        return createHookPromise().then(function(value) {
          // If disposed while waiting, signal done
          if (isDisposed) return { done: true, value: undefined };
          return { done: false, value: value };
        });
      },
      return: function() {
        disposeHook();
        return Promise.resolve({ done: true, value: undefined });
      },
    };
  };

  return hook;
};

// setAttributes — attaches plaintext metadata to the current run.
// Validation happens in library code (normalizeAttributeChanges) before
// this dispatcher is invoked, so "changes" is already normalized. The
// returned promise resolves when the matching attr_set event is
// observed during event processing — mirroring the node:vm engine's
// createSetAttributes (attribute-dispatcher.ts).
globalThis[Symbol.for("WORKFLOW_SET_ATTRIBUTES")] = function(changes, options) {
  var correlationId = "attr_" + globalThis.__generateUlid();
  globalThis.__pending.push({
    type: "attribute",
    correlationId: correlationId,
    changes: changes,
    allowReservedAttributes: !!(options && options.allowReservedAttributes),
    hasCreatedEvent: false,
  });
  return new Promise(function(resolve, reject) {
    globalThis.__registerResolver(correlationId, resolve, reject);
  });
};

// ---- AbortController / AbortSignal (hook-backed) ----
// Port of workflow/abort-controller.ts to the VM pending-op model:
// the controller registers a system hook; abort() flips the signal
// synchronously and marks the pending op so the host records the abort
// (hook_received event + stream packet). On replay, the recorded
// hook_received event calls _setAborted during event processing and the
// workflow's own abort() call becomes a no-op.
var __ABORT_STREAM_NAME = Symbol.for("WORKFLOW_ABORT_STREAM_NAME");
var __ABORT_HOOK_TOKEN = Symbol.for("WORKFLOW_ABORT_HOOK_TOKEN");

function __makeAbortError() {
  if (typeof DOMException !== "undefined") {
    return new DOMException("The operation was aborted.", "AbortError");
  }
  var e = new Error("The operation was aborted.");
  e.name = "AbortError";
  return e;
}

function WorkflowAbortSignal(streamName, hookToken) {
  this.aborted = false;
  this.reason = undefined;
  this[__ABORT_STREAM_NAME] = streamName;
  this[__ABORT_HOOK_TOKEN] = hookToken;
  this.__listeners = [];
  this.__onabort = null;
}
Object.defineProperty(WorkflowAbortSignal.prototype, "onabort", {
  get: function() { return this.__onabort; },
  set: function(handler) {
    this.__onabort = handler;
    if (handler && this.aborted) handler.call(this);
  },
});
WorkflowAbortSignal.prototype._setAborted = function(reason) {
  if (this.aborted) return;
  this.aborted = true;
  this.reason = reason;
  if (this.__onabort) this.__onabort.call(this);
  var listeners = this.__listeners;
  this.__listeners = [];
  for (var i = 0; i < listeners.length; i++) listeners[i]();
};
WorkflowAbortSignal.prototype.addEventListener = function(type, listener) {
  if (type !== "abort") return;
  if (this.aborted) {
    // Fire synchronously (not on a microtask) for deterministic replay —
    // matches the node:vm engine's WorkflowAbortSignal.
    listener();
    return;
  }
  this.__listeners.push(listener);
};
WorkflowAbortSignal.prototype.removeEventListener = function(type, listener) {
  if (type !== "abort") return;
  this.__listeners = this.__listeners.filter(function(l) { return l !== listener; });
};
WorkflowAbortSignal.prototype.throwIfAborted = function() {
  if (this.aborted) {
    throw this.reason !== undefined && this.reason !== null
      ? this.reason
      : __makeAbortError();
  }
};
// Expose for the host serde's revivers (they look the class up lazily,
// through a handle, at revive time).
globalThis.__WorkflowAbortSignal = WorkflowAbortSignal;

// Registry of live abort signals keyed by their hook correlationId. The
// host delivers hook_received events for these ids as _setAborted calls.
globalThis.__abortSignals = {};

globalThis.AbortController = function WorkflowAbortController() {
  var id = globalThis.__generateUlid();
  var streamName = "strm_" + id + "_system_abort";
  var hookToken = "abrt_" + id;
  this[__ABORT_STREAM_NAME] = streamName;
  this[__ABORT_HOOK_TOKEN] = hookToken;
  this.signal = new WorkflowAbortSignal(streamName, hookToken);
  var correlationId = "hook_" + globalThis.__generateUlid();
  // Register an internal system hook. isSystem prevents token namespace
  // conflicts with user hooks.
  globalThis.__pending.push({
    type: "hook",
    correlationId: correlationId,
    token: hookToken,
    isWebhook: false,
    isSystem: true,
    hasCreatedEvent: false,
  });
  globalThis.__abortSignals[correlationId] = this.signal;
};
globalThis.AbortController.prototype.abort = function(reason) {
  if (this.signal.aborted) return; // already aborted (e.g. from replay)
  this.signal._setAborted(reason);
  // Mark the pending hook op so the host records the abort. The payload
  // stays a RAW value; the host serializes it through a handle with full
  // type fidelity (Errors, DOMException, custom values).
  var token = this[__ABORT_HOOK_TOKEN];
  for (var i = 0; i < globalThis.__pending.length; i++) {
    var item = globalThis.__pending[i];
    if (item.type === "hook" && item.token === token) {
      item.abortRequested = true;
      item.abortPayload = {
        aborted: true,
        reason: reason,
      };
      break;
    }
  }
};

globalThis.AbortSignal = {
  abort: function(reason) {
    var s = new WorkflowAbortSignal("", "");
    s._setAborted(reason !== undefined ? reason : __makeAbortError());
    return s;
  },
  any: function(signals) {
    var composite = new WorkflowAbortSignal("", "");
    var arr = Array.from(signals);
    for (var i = 0; i < arr.length; i++) {
      if (arr[i].aborted) {
        composite._setAborted(arr[i].reason);
        return composite;
      }
    }
    var listeners = [];
    var cleanup = function() {
      for (var j = 0; j < listeners.length; j++) {
        if (listeners[j].signal.removeEventListener) {
          listeners[j].signal.removeEventListener("abort", listeners[j].listener);
        }
      }
      listeners.length = 0;
    };
    arr.forEach(function(signal) {
      if (!signal.addEventListener) return;
      var listener = function() {
        if (!composite.aborted) {
          composite._setAborted(signal.reason);
          cleanup();
        }
      };
      listeners.push({ signal: signal, listener: listener });
      signal.addEventListener("abort", listener);
    });
    return composite;
  },
  timeout: function() {
    throw new Error(
      "AbortSignal.timeout() is not supported in workflow functions. " +
        "Use sleep() with an AbortController instead. " +
        "See: /docs/errors/abort-signal-timeout-in-workflow"
    );
  },
};

// WORKFLOW_GET_STREAM_ID — generates a stream ID for a workflow run.
// Replicates getWorkflowRunStreamId() from util.ts inside the QuickJS VM.
// Uses the built-in btoa() for base64url encoding.
globalThis[Symbol.for("WORKFLOW_GET_STREAM_ID")] = function(namespace) {
  var runId = globalThis[Symbol.for("WORKFLOW_CONTEXT")]
    ? globalThis[Symbol.for("WORKFLOW_CONTEXT")].workflowRunId
    : "";
  var streamId = runId.replace("wrun_", "strm_") + "_user";
  if (!namespace) return streamId;
  // base64url: btoa then replace + with -, / with _, strip =
  var b64 = btoa(namespace).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
  return streamId + "_" + b64;
};
`;

// ---- Runtime ----

/**
 * Phase 1 — static (run-independent) VM initialization.
 *
 * Creates a QuickJS VM and loads everything that does not depend on a
 * specific workflow run: the workflow-primitive bootstrap (useStep /
 * sleep / createHook / Response-Request polyfills). Serialization is
 * host-side (quickjs-serde.ts) and captures its intrinsics from the VM
 * right after this returns.
 *
 * `getNowMs` backs the VM's WASI clock (`Date.now()` / `new Date()`
 * inside the VM). The callback itself is static — the per-run state it
 * reads lives on the host and is advanced as events are consumed,
 * matching the node:vm engine's deterministic replay clock.
 *
 * This phase is the future boundary for VM-memory snapshotting: a
 * build-time snapshot can capture the VM right after this function and
 * new runs can restore from it instead of paying VM creation + eval cost
 * (`QuickJS.restore` accepts the same wasi override).
 */
/**
 * Loosely-typed accessor for the `WebAssembly` global. The package
 * tsconfig's `lib: ["es2022"]` does not include the DOM lib where the
 * `WebAssembly` namespace types live; the runtime global is available on
 * every WASM-capable platform this engine targets.
 */
const WebAssemblyGlobal = (globalThis as any).WebAssembly as {
  compile(bytes: Uint8Array): Promise<object>;
};

type CompiledExtension = Omit<ExtensionDescriptor, 'wasm'> & {
  wasm: ExtensionDescriptor['wasm'];
};

/**
 * Process-wide cache of the compiled `WebAssembly.Module`s for the main
 * QuickJS runtime and its native extensions. `WebAssembly.compile` of the
 * ~600 KB runtime binary is the most expensive part of VM creation and is
 * pure (no per-VM state — instantiation binds the per-VM memory), so it
 * only needs to happen once per process. The promise is cached (not the
 * result) so concurrent first invocations share a single compilation.
 */
let compiledAssetsPromise:
  | Promise<{
      wasm: object;
      extensions: CompiledExtension[];
    }>
  | undefined;

function getCompiledAssets() {
  if (!compiledAssetsPromise) {
    compiledAssetsPromise = (async () => {
      const [wasm, ...extensionModules] = await Promise.all([
        WebAssemblyGlobal.compile(quickjsWasm),
        ...quickjsExtensions.map((ext) =>
          WebAssemblyGlobal.compile(ext.wasm as Uint8Array)
        ),
      ]);
      return {
        wasm,
        extensions: quickjsExtensions.map((ext, i) => ({
          ...ext,
          wasm: extensionModules[i] as ExtensionDescriptor['wasm'],
        })),
      };
    })();
    // On failure, clear the cache so a later invocation can retry rather
    // than being stuck with a rejected promise forever.
    compiledAssetsPromise.catch(() => {
      compiledAssetsPromise = undefined;
    });
  }
  return compiledAssetsPromise;
}

async function initWorkflowVM(
  getNowMs: () => number,
  interruptBudget: InterruptBudget
): Promise<QuickJS> {
  // Deterministic replay clock: Date.now() / new Date() inside the VM
  // read the host-controlled clock instead of wall time. Replay
  // re-executes the workflow from the top on every invocation, so the
  // clock must be derived from the event log (not real time) for the
  // workflow to observe stable timestamps across invocations.
  const wasi: WasiOptions = (memory) => ({
    clock_time_get(_clockId: number, _precision: bigint, resultPtr: number) {
      const timeNs = BigInt(Math.round(getNowMs())) * 1_000_000n;
      new DataView(memory.buffer).setBigUint64(resultPtr, timeNs, true);
      return 0;
    },
  });

  const assets = await getCompiledAssets();
  const vm = await QuickJS.create({
    wasm: assets.wasm as never,
    memoryLimit: 256 * 1024 * 1024,
    interruptHandler: createInterruptHandler(interruptBudget),
    extensions: assets.extensions,
    wasi,
  });

  // Bootstrap workflow primitives
  vm.evalCode(VM_BOOTSTRAP, 'bootstrap.js').dispose();

  return vm;
}

/**
 * A live QuickJS workflow invocation. When the initial `result` is
 * `suspended`, the VM is kept alive so the caller can feed newly recorded
 * events (e.g. terminal events of inline-executed steps) into the SAME VM
 * via `continueWithEvents` — resuming execution exactly where it left off
 * without a fresh-VM re-replay. Terminal results dispose the VM
 * automatically; `dispose()` must be called when abandoning a suspended
 * session (idempotent).
 */
export interface QuickJSWorkflowSession {
  result: QuickJSRuntimeResult;
  /**
   * Process newly recorded events in the live VM and re-evaluate the
   * workflow state. Only valid while the last result was `suspended`.
   * Resets the VM's interrupt budget for the new execution burst.
   */
  continueWithEvents(newEvents: Event[]): Promise<QuickJSRuntimeResult>;
  /** Dispose the VM if it is still alive. Safe to call multiple times. */
  dispose(): void;
}

/**
 * Run a workflow invocation to its first settled state and dispose the
 * VM. Convenience wrapper over {@link startQuickJSWorkflow} for callers
 * (and tests) that don't use live-VM continuation.
 */
export async function runQuickJSWorkflow(
  options: QuickJSRuntimeOptions
): Promise<QuickJSRuntimeResult> {
  const session = await startQuickJSWorkflow(options);
  session.dispose();
  return session.result;
}

export async function startQuickJSWorkflow(
  options: QuickJSRuntimeOptions
): Promise<QuickJSWorkflowSession> {
  const { workflowCode, workflowId, workflowRun, events } = options;

  const startedAt = workflowRun.startedAt ? +workflowRun.startedAt : Date.now();

  // Deterministic PRNG seed — identical for EVERY invocation of the same
  // run. Full event replay requires this: each invocation re-executes the
  // workflow from the top and must regenerate the exact same correlationId
  // sequence so that pending operations re-created by replay match the
  // events recorded by earlier invocations. Sequential operations within
  // one execution still get distinct ids because the PRNG advances as the
  // workflow draws from it. Identical seeding across CONCURRENT invocations
  // of the same run is also load-bearing: both produce the same ids, and
  // the world's per-(runId, correlationId) uniqueness turns the duplicate
  // `events.create` into an EntityConflictError that the entrypoint
  // swallows.
  //
  // The seed inputs MUST be stable across invocations. Notably
  // `startedAt` is NOT: under turbo the first invocation runs against a
  // synthesized run object whose timestamps differ from the durably
  // stored ones that later invocations load. Matches the node:vm
  // engine's seed (workflow.ts).
  const seed = [
    workflowRun.runId,
    workflowRun.workflowName,
    workflowRun.deploymentId,
  ].join(':');
  const rng = seedrandom(seed);

  // Seeded nanoid generator — uses the same nanoid package and seeded PRNG
  // as the node:vm engine for consistent token generation.
  const generateNanoid = nanoid.customRandom(nanoid.urlAlphabet, 21, (size) =>
    new Uint8Array(size).map(() => 256 * rng())
  );

  // Deterministic replay clock, mirroring the node:vm engine (see
  // workflow.ts): the initial value is the run's creation time recovered
  // from the ULID embedded in `runId` (falling back to `createdAt`), and
  // it advances to each processed event's `createdAt` as the event log is
  // replayed. Monotonic (Math.max) so the outer processEvents re-scan
  // loop can't move the clock backwards mid-execution.
  let vmNowMs =
    runIdCreatedAt(workflowRun.runId) ?? (+workflowRun.createdAt || startedAt);
  const advanceClock = (ms: number) => {
    if (Number.isFinite(ms)) vmNowMs = Math.max(vmNowMs, ms);
  };

  // ---- Phase 1: static initialization ----
  const interruptBudget: InterruptBudget = { start: Date.now() };
  const vm = await initWorkflowVM(() => vmNowMs, interruptBudget);

  // Host-side serde: captures the VM's intrinsics (bootstrap included)
  // before any user code runs. All serialization now happens on the host
  // through handles — no serializer code is evaluated inside the VM.
  const serde = createQuickJSSerde(vm);

  // Any throw between here and the terminal paths (which dispose the VM
  // inside checkWorkflowState / extractError before RETURNING) would leak
  // a live QuickJS instance and its WASM linear memory for the lifetime
  // of the compute instance — which is reused. Dispose on the way out of
  // an exceptional exit and rethrow.
  try {
    return await runWorkflowInVM();
  } catch (err) {
    try {
      vm.dispose();
    } catch {
      // Already disposed by a terminal path — ignore.
    }
    throw err;
  }

  // ---- Phase 2: per-run initialization ----
  async function runWorkflowInVM(): Promise<QuickJSWorkflowSession> {
    // Seeded Math.random
    {
      using randomFn = vm.newFunction('random', () => vm.newNumber(rng()));
      using math = vm.global.getProp('Math');
      math.setProp('random', randomFn);
    }

    // Seeded nanoid generator
    {
      using nanoidFn = vm.newFunction('__generateNanoid', () =>
        vm.newString(generateNanoid())
      );
      vm.setProp(vm.global, '__generateNanoid', nanoidFn);
    }

    // Host-side deterministic ULID generator for correlationIds. Uses the
    // same `ulid` package and monotonic factory as before, drawing from
    // the SAME seeded PRNG instance as the VM's Math.random — so the
    // interleaved draw sequence (and therefore every correlationId) is
    // byte-identical to what the previous in-VM ULID factory produced for
    // the same run. The time prefix is derived from the runId's embedded
    // ULID (stable across invocations by construction — unlike
    // `startedAt`, which differs between turbo's synthesized run object
    // and the durably stored run), so two concurrent invocations of the
    // same run produce IDENTICAL correlationIds and the world's
    // EntityConflictError on `events.create` dedups one of each pair.
    {
      const ulidFactory = monotonicFactory(() => rng());
      const ulidTimestamp =
        runIdCreatedAt(workflowRun.runId) ??
        (+workflowRun.createdAt || startedAt);
      using ulidFn = vm.newFunction('__generateUlid', () =>
        vm.newString(ulidFactory(ulidTimestamp))
      );
      vm.setProp(vm.global, '__generateUlid', ulidFn);
    }

    // `process.env` — parity with the node:vm engine, which exposes a frozen
    // copy of the host env (vm/index.ts). Injected per run so the snapshot of
    // the env is taken at invocation time, same as node.
    {
      const envHandle = vm.newString(JSON.stringify(process.env));
      vm.setProp(vm.global, '__wdk_env', envHandle);
      envHandle.dispose();
      vm.evalCode(
        'globalThis.process = { env: Object.freeze(JSON.parse(globalThis.__wdk_env)) };' +
          'delete globalThis.__wdk_env;'
      ).dispose();
    }

    // Execute the workflow bundle — use the workflowId as the eval filename
    // so QuickJS stack traces reference the workflow name, enabling source map
    // remapping by remapErrorStack (which matches frames by filename).
    // Evaluated in the per-run phase (after Math.random seeding) so that
    // module-scope user code draws from the seeded PRNG, matching the
    // node:vm engine's replay determinism.
    try {
      vm.evalCode(workflowCode, workflowId || 'workflow.js').dispose();
    } catch (err) {
      return makeSettledSession(
        extractError(vm, err, 'Workflow evaluation failed')
      );
    }

    // Extract workflow arguments. Prefer the run_created event; fall back
    // to the queue message's runInput if the event log is incomplete
    // (eventually-consistent read after start()). Failing to find input
    // for a first invocation is fatal — running the workflow function
    // with no args would silently turn typed arguments into `undefined`
    // and, for recursive workflows, produce exponential fan-out.
    const runCreatedEvent = events.find((e) => e.eventType === 'run_created');
    const runCreatedInput =
      runCreatedEvent && 'eventData' in runCreatedEvent
        ? (runCreatedEvent.eventData as Record<string, unknown>)?.input
        : undefined;
    const runInput: unknown =
      runCreatedInput ?? (options.runInput?.input as unknown);

    if (runInput instanceof Uint8Array) {
      const decryptedInput = await prepareBytesForVM(
        runInput,
        options.encryptionKey
      );
      runtimeLogger.debug('QuickJS runtime: run input format', {
        prefix: new TextDecoder().decode(decryptedInput.subarray(0, 4)),
        byteLength: decryptedInput.byteLength,
        source: runCreatedInput ? 'run_created' : 'queueMessage.runInput',
      });
      // Build the argument value directly in the VM via the host-side
      // serde (guest code never sees the wire bytes).
      const inputHandle = serde.deserialize(decryptedInput);
      vm.setProp(vm.global, '__wdk_input', inputHandle);
      inputHandle.dispose();
    } else if (runInput === undefined && events.length > 0) {
      // The event log is non-empty (we got run_started or similar) but
      // no run_created event was found and no queue-provided runInput is
      // available. This is the race condition observed during the fib
      // incident — silently dropping arguments would turn `n` into
      // `undefined` and, for recursive workflows, cause exponential
      // fan-out. Fail loud: the throw escapes the entrypoint into the
      // replay loop's catch in runtime.ts (the QuickJS dispatch runs
      // inside that loop's try), which records run_failed. A visible
      // terminal failure is
      // preferred over silently executing with undefined arguments — the
      // queue-provided runInput fallback above makes this path rare.
      // Empty `events` is allowed because tests that bootstrap a workflow
      // with no arguments rely on the old permissive behavior.
      throw new Error(
        `Cannot start workflow run "${workflowRun.runId}": no run_created event found and no runInput in the queue payload, but other events are present (likely a read-after-write race during start()).`
      );
    }

    // Set workflow context metadata (for getWorkflowMetadata()).
    // Must match the shape that the node:vm engine produces (see
    // packages/core/src/workflow.ts: runWorkflow → ctx) so user code
    // that compares `getWorkflowMetadata()` values between a step
    // (server-side) and the workflow (VM-side) sees identical objects.
    {
      const metadata = {
        workflowName: workflowRun.workflowName,
        workflowRunId: workflowRun.runId,
        workflowStartedAt: workflowRun.startedAt
          ? new Date(+workflowRun.startedAt)
          : new Date(),
        url: process.env.VERCEL_URL
          ? `https://${process.env.VERCEL_URL}`
          : `http://localhost:${options.port ?? 3000}`,
        features: { encryption: !!options.encryptionKey },
      };
      vm.evalCode(
        `globalThis[Symbol.for("WORKFLOW_CONTEXT")] = ${JSON.stringify(metadata)};` +
          `globalThis[Symbol.for("WORKFLOW_CONTEXT")].workflowStartedAt = new Date(${JSON.stringify(metadata.workflowStartedAt.toISOString())});`
      ).dispose();
    }

    // Start the workflow function. If the workflow isn't registered,
    // throw an error tagged with `name = "WorkflowNotRegisteredError"`
    // so the host-side entrypoint can reconstruct a real
    // WorkflowNotRegisteredError (a WorkflowRuntimeError subclass that
    // classifies as RUNTIME_ERROR) rather than a generic user error.
    // See quickjs-entrypoint.ts's run_failed branch.
    try {
      vm.evalCode(`
      var __wfn = globalThis.__private_workflows.get(${JSON.stringify(workflowId)});
      if (!__wfn) {
        var __wfnErr = new Error("Workflow \\"" + ${JSON.stringify(workflowId)} + "\\" is not registered in the current deployment.");
        __wfnErr.name = "WorkflowNotRegisteredError";
        throw __wfnErr;
      }
      var __args = globalThis.__wdk_input !== undefined
        ? globalThis.__wdk_input
        : [];
      delete globalThis.__wdk_input;
      if (!Array.isArray(__args)) __args = [__args];
      __wfn.apply(null, __args).then(
        function(result) {
          // Store the RAW result; the host serializes it through a handle.
          // A separate done flag distinguishes "completed with undefined"
          // from "not completed".
          globalThis.__workflowDone = true;
          globalThis.__workflowResult = result;
        },
        function(error) {
          // Preserve display info on the host-side failed object
          // (matches the legacy host-visible shape) AND keep the RAW
          // thrown value so the host can serialize the original
          // type-identity, cause chain, or non-Error throws verbatim
          // through the standard error pipeline.
          globalThis.__workflowError = {
            message: error && error.message != null ? String(error.message) : String(error),
            stack: error && error.stack ? error.stack : "",
            name: error && error.name ? error.name : (error instanceof Error ? "Error" : typeof error),
            value: error,
          };
        }
      );
    `).dispose();
    } catch (err) {
      return makeSettledSession(
        extractError(vm, err, 'Failed to start workflow')
      );
    }

    // Process events and drain jobs in a loop. Events may resolve promises
    // that unblock workflow code, which then creates NEW resolvers for
    // subsequent events. Re-processing events matches these new resolvers
    // against events that were already delivered.
    {
      let maxIterations = 100;
      let madeProgress: boolean;
      do {
        madeProgress = await processEvents(
          vm,
          serde,
          events,
          advanceClock,
          options.encryptionKey
        );
        let batch: number;
        do {
          batch = vm.executePendingJobs();
          if (batch > 0) madeProgress = true;
        } while (batch > 0);
      } while (madeProgress && --maxIterations > 0);
      if (madeProgress && maxIterations === 0) {
        // The drain loop hit its bound while still making progress —
        // proceeding as if it converged would present as a mysterious
        // suspension or replay divergence. Make the giving-up visible so
        // a wedge is attributable to this bound rather than a mystery.
        runtimeLogger.warn(
          'QuickJS runtime: event drain loop hit its iteration bound before reaching a fixed point',
          {
            workflowRunId: workflowRun.runId,
            eventCount: events.length,
          }
        );
      }
    }

    // ---- Check result ----
    return makeLiveSession(
      vm,
      serde,
      interruptBudget,
      advanceClock,
      options.encryptionKey
    );
  }
}

/** Session wrapper for a result whose VM is already settled/disposed. */
function makeSettledSession(
  result: QuickJSRuntimeResult
): QuickJSWorkflowSession {
  return {
    result,
    continueWithEvents: () => {
      throw new Error(
        'QuickJS workflow session is settled — continueWithEvents is only valid while suspended'
      );
    },
    dispose: () => {},
  };
}

/**
 * Evaluate the VM's state and wrap it in a live session. While suspended,
 * the VM stays alive so `continueWithEvents` can resume it in place;
 * terminal states dispose the VM immediately (inside checkWorkflowState).
 */
function makeLiveSession(
  vm: QuickJS,
  serde: QuickJSSerde,
  interruptBudget: InterruptBudget,
  advanceClock: (ms: number) => void,
  encryptionKey?: DecryptionKey
): QuickJSWorkflowSession {
  const result = checkWorkflowState(vm, serde, { keepAliveOnSuspend: true });
  let alive = !!result.suspended;

  const session: QuickJSWorkflowSession = {
    result,
    async continueWithEvents(
      newEvents: Event[]
    ): Promise<QuickJSRuntimeResult> {
      if (!alive) {
        throw new Error(
          'QuickJS workflow session is not alive — continueWithEvents is only valid while suspended'
        );
      }
      // Fresh execution burst — the interrupt budget bounds VM compute,
      // not wall time spent waiting on inline steps between bursts.
      interruptBudget.start = Date.now();

      let maxIterations = 100;
      let madeProgress: boolean;
      do {
        madeProgress = await processEvents(
          vm,
          serde,
          newEvents,
          advanceClock,
          encryptionKey
        );
        let batch: number;
        do {
          batch = vm.executePendingJobs();
          if (batch > 0) madeProgress = true;
        } while (batch > 0);
      } while (madeProgress && --maxIterations > 0);

      const next = checkWorkflowState(vm, serde, {
        keepAliveOnSuspend: true,
      });
      if (!next.suspended) alive = false;
      session.result = next;
      return next;
    },
    dispose(): void {
      if (alive) {
        alive = false;
        try {
          vm.dispose();
        } catch {
          // Already disposed — ignore.
        }
      }
    },
  };
  return session;
}

// ---- Event Processing ----

async function processEvents(
  vm: QuickJS,
  serde: QuickJSSerde,
  events: Event[],
  advanceClock: (ms: number) => void,
  encryptionKey?: DecryptionKey
): Promise<boolean> {
  let resolved = false;
  for (const event of events) {
    // Advance the VM's deterministic clock to this event's creation time
    // BEFORE resolving anything, so workflow code unblocked by this event
    // observes Date.now() at (or after — the clock is monotonic) the time
    // the event was recorded. Mirrors the node:vm engine's
    // `onConsumedEvent → updateTimestamp(+event.createdAt)`.
    advanceClock(+event.createdAt);

    const cid = event.correlationId;
    if (!cid) continue;

    // JSON.stringify handles quotes, backslashes and control characters;
    // correlation ids are host-generated ULIDs today, but the eval-string
    // safety shouldn't depend on that invariant being asserted nowhere.
    const cidJs = JSON.stringify(cid);
    const eventData =
      'eventData' in event
        ? (event.eventData as Record<string, unknown>)
        : undefined;

    // Log the event and whether the resolver exists
    switch (event.eventType) {
      case 'step_completed': {
        const hasResolver = vm.dump(
          vm.evalCode(`!!globalThis.__resolvers[${cidJs}]`)
        );
        const rawOutput = eventData?.result ?? eventData?.output;
        if (hasResolver) {
          if (rawOutput instanceof Uint8Array) {
            // Decrypt if encrypted — the VM only understands 'devl' format
            runtimeLogger.debug('QuickJS runtime: step result raw', {
              correlationId: cid,
              rawPrefix: new TextDecoder().decode(rawOutput.subarray(0, 4)),
              rawByteLength: rawOutput.byteLength,
              isBuffer: Buffer.isBuffer(rawOutput),
            });
            const decryptedOutput = await prepareBytesForVM(
              rawOutput,
              encryptionKey
            );
            runtimeLogger.debug('QuickJS runtime: step result decrypted', {
              correlationId: cid,
              prefix: new TextDecoder().decode(decryptedOutput.subarray(0, 4)),
              byteLength: decryptedOutput.byteLength,
            });
            const valueHandle = serde.deserialize(decryptedOutput);
            vm.setProp(vm.global, '__tmp_result', valueHandle);
            valueHandle.dispose();
            vm.evalCode(
              `globalThis.__resolvers[${cidJs}].resolve(globalThis.__tmp_result);` +
                `delete globalThis.__resolvers[${cidJs}];` +
                `delete globalThis.__tmp_result;`
            ).dispose();
          } else {
            runtimeLogger.debug('QuickJS runtime: step result non-binary', {
              correlationId: cid,
              type: typeof rawOutput,
              isNull: rawOutput === null,
              isUndefined: rawOutput === undefined,
              constructor: rawOutput?.constructor?.name,
            });
            const serialized =
              rawOutput !== undefined ? JSON.stringify(rawOutput) : 'undefined';
            vm.evalCode(
              `globalThis.__resolvers[${cidJs}].resolve(${serialized});` +
                `delete globalThis.__resolvers[${cidJs}];`
            ).dispose();
          }
          // Drain ALL microtasks after resolve
          {
            resolved = true;
            let b: number;
            do {
              b = vm.executePendingJobs();
            } while (b > 0);
          }
        } else {
          // No resolver yet — buffer the prepared outcome so the promise
          // settles the moment the VM constructs it (see __terminalBuffer
          // in the bootstrap). Without this, the live-continuation path
          // (which scans each delta exactly once) drops the terminal and
          // the await never settles.
          if (rawOutput instanceof Uint8Array) {
            const decryptedOutput = await prepareBytesForVM(
              rawOutput,
              encryptionKey
            );
            // Host serde: deserialize into a VM value NOW (same path as
            // the resolver branch above) and buffer the value itself.
            const valueHandle = serde.deserialize(decryptedOutput);
            vm.setProp(vm.global, '__tmp_buf', valueHandle);
            valueHandle.dispose();
            vm.evalCode(
              `globalThis.__terminalBuffer[${cidJs}] = { kind: "resolve_value", value: globalThis.__tmp_buf };` +
                `delete globalThis.__tmp_buf;`
            ).dispose();
          } else {
            const serialized =
              rawOutput !== undefined ? JSON.stringify(rawOutput) : 'undefined';
            vm.evalCode(
              `globalThis.__terminalBuffer[${cidJs}] = { kind: "resolve_value", value: ${serialized} };`
            ).dispose();
          }
        }
        markCreated(vm, cidJs);
        break;
      }
      case 'step_failed': {
        const hasResolver = vm.dump(
          vm.evalCode(`!!globalThis.__resolvers[${cidJs}]`)
        );
        if (hasResolver) {
          const errorData = eventData?.error;
          if (errorData instanceof Uint8Array) {
            // Modern path (post-#1851): the step handler dehydrated the
            // thrown value through the first-class error pipeline. Decrypt
            // (if encrypted) and pass the bytes to the VM-side deserializer
            // so the workflow catch sees a properly typed Error subclass
            // (TypeError, FatalError with original cause chain, etc.) with
            // the original message and stack preserved.
            const decrypted = await prepareBytesForVM(errorData, encryptionKey);
            const errorHandle = serde.deserialize(decrypted);
            vm.setProp(vm.global, '__tmp_error', errorHandle);
            errorHandle.dispose();
            vm.evalCode(
              `(function(){` +
                `globalThis.__resolvers[${cidJs}].reject(globalThis.__tmp_error);` +
                `delete globalThis.__resolvers[${cidJs}];` +
                `delete globalThis.__tmp_error;` +
                `})()`
            ).dispose();
          } else {
            // Legacy path: pre-pipeline events stored error as
            // `{ message, stack, code }`. Reconstruct a FatalError so
            // workflow catch can detect it via FatalError.is(), matching
            // the original V1 step handler behavior.
            const isErrorObject =
              typeof errorData === 'object' && errorData !== null;
            const msg = isErrorObject
              ? (((errorData as Record<string, unknown>).message as string) ??
                'Step failed')
              : typeof errorData === 'string'
                ? errorData
                : 'Step failed';
            const errorStack =
              (isErrorObject
                ? (errorData as Record<string, unknown>).stack
                : undefined) ?? (eventData?.stack as string | undefined);
            const stackAssignment = errorStack
              ? `e.stack=${JSON.stringify(errorStack)};`
              : '';
            vm.evalCode(
              `(function(){var e=new Error(${JSON.stringify(msg)});e.name="FatalError";e.fatal=true;${stackAssignment}` +
                `globalThis.__resolvers[${cidJs}].reject(e);` +
                `delete globalThis.__resolvers[${cidJs}];})()`
            ).dispose();
          }
          {
            resolved = true;
            let b: number;
            do {
              b = vm.executePendingJobs();
            } while (b > 0);
          }
        } else {
          // No resolver yet — buffer the prepared rejection (see the
          // step_completed branch above for the rationale).
          const errorData = eventData?.error;
          if (errorData instanceof Uint8Array) {
            const decrypted = await prepareBytesForVM(errorData, encryptionKey);
            // Host serde: deserialize into the VM error value NOW (same
            // path as the resolver branch above) and buffer it.
            const errorHandle = serde.deserialize(decrypted);
            vm.setProp(vm.global, '__tmp_buf', errorHandle);
            errorHandle.dispose();
            vm.evalCode(
              `globalThis.__terminalBuffer[${cidJs}] = { kind: "reject_value", value: globalThis.__tmp_buf };` +
                `delete globalThis.__tmp_buf;`
            ).dispose();
          } else {
            const isErrorObject =
              typeof errorData === 'object' && errorData !== null;
            const msg = isErrorObject
              ? (((errorData as Record<string, unknown>).message as string) ??
                'Step failed')
              : typeof errorData === 'string'
                ? errorData
                : 'Step failed';
            const errorStack =
              (isErrorObject
                ? (errorData as Record<string, unknown>).stack
                : undefined) ?? (eventData?.stack as string | undefined);
            vm.evalCode(
              `globalThis.__terminalBuffer[${cidJs}] = { kind: "reject_error", message: ${JSON.stringify(msg)}, stack: ${errorStack ? JSON.stringify(errorStack) : 'undefined'} };`
            ).dispose();
          }
        }
        markCreated(vm, cidJs);
        break;
      }
      case 'wait_completed': {
        const hasResolver = vm.dump(
          vm.evalCode(`!!globalThis.__resolvers[${cidJs}]`)
        );
        if (hasResolver) {
          vm.evalCode(
            `globalThis.__resolvers[${cidJs}].resolve();` +
              `delete globalThis.__resolvers[${cidJs}];`
          ).dispose();
          {
            resolved = true;
            let b: number;
            do {
              b = vm.executePendingJobs();
            } while (b > 0);
          }
        } else {
          // No resolver yet — buffer (see step_completed above).
          vm.evalCode(
            `globalThis.__terminalBuffer[${cidJs}] = { kind: "resolve_undefined" };`
          ).dispose();
        }
        markCreated(vm, cidJs);
        break;
      }
      case 'attr_set': {
        // Only workflow-written attribute events resolve a pending
        // setAttributes() promise; step/system writers share no
        // correlationIds with VM resolvers, so the guard is defensive.
        const writer = (eventData?.writer as { type?: string } | undefined)
          ?.type;
        if (writer !== 'workflow') break;
        const hasResolver = vm.dump(
          vm.evalCode(`!!globalThis.__resolvers[${cidJs}]`)
        );
        if (!hasResolver) {
          // No resolver yet — buffer (see step_completed above).
          vm.evalCode(
            `globalThis.__terminalBuffer[${cidJs}] = { kind: "resolve_undefined" };`
          ).dispose();
        }
        if (hasResolver) {
          vm.evalCode(
            `globalThis.__resolvers[${cidJs}].resolve();` +
              `delete globalThis.__resolvers[${cidJs}];`
          ).dispose();
          {
            resolved = true;
            let b: number;
            do {
              b = vm.executePendingJobs();
            } while (b > 0);
          }
        }
        markCreated(vm, cidJs);
        break;
      }
      case 'hook_received': {
        // Check if this event was already processed (delivered or
        // buffered) within this invocation. Prevents double-delivery when
        // the outer loop re-scans events.
        const alreadyProcessed = event.eventId
          ? vm.dump(
              vm.evalCode(
                `!!(globalThis.__hookPayloadBuffer.__processedEventIds && globalThis.__hookPayloadBuffer.__processedEventIds[${JSON.stringify(event.eventId)}])`
              )
            )
          : false;
        if (alreadyProcessed) {
          runtimeLogger.debug(
            'QuickJS runtime: hook_received already processed',
            {
              correlationId: cid,
              eventId: event.eventId,
            }
          );
          markCreated(vm, cidJs);
          break;
        }

        // Resilient-resume dedup (parity with the node engine's
        // EventsConsumer in workflow/hook.ts): two hook_received rows for
        // ONE resume attempt share a client-minted `resumeId` (a duplicate
        // can be committed when the materialization fallback races a
        // delayed direct write — hook_received has no storage uniqueness
        // constraint). Deliver only the first-in-log occurrence. The seen
        // set lives in the VM heap so it is deterministic per replay and
        // survives event re-scans within the invocation. Events without a
        // resumeId (older SDKs) are never deduped.
        {
          // Top-level event.resumeId is the canonical location (the backend
          // hoists it to a first-class column); the nested
          // eventData.resumeId form is a deprecated legacy fallback —
          // mirrors the node engine's dedup in workflow/hook.ts.
          const resumeId =
            (event as { resumeId?: unknown }).resumeId ??
            (eventData as { resumeId?: unknown } | undefined)?.resumeId;
          if (typeof resumeId === 'string') {
            const resumeIdJs = JSON.stringify(resumeId);
            const duplicate = vm.dump(
              vm.evalCode(
                `(globalThis.__hookSeenResumeIds = globalThis.__hookSeenResumeIds || {})[${resumeIdJs}] === true`
              )
            );
            if (duplicate) {
              runtimeLogger.debug(
                'QuickJS runtime: duplicate hook_received for the same resume attempt, dropping',
                { correlationId: cid, eventId: event.eventId, resumeId }
              );
              if (event.eventId) {
                vm.evalCode(
                  `(globalThis.__hookPayloadBuffer.__processedEventIds = globalThis.__hookPayloadBuffer.__processedEventIds || {})[${JSON.stringify(event.eventId)}] = true;`
                ).dispose();
              }
              markCreated(vm, cidJs);
              break;
            }
            vm.evalCode(
              `globalThis.__hookSeenResumeIds[${resumeIdJs}] = true;`
            ).dispose();
          }
        }

        // Abort delivery: hook_received for an AbortController's system
        // hook flips the registered signal instead of resolving a promise.
        // The payload is the dehydrated `{ aborted: true, reason }` object.
        const isAbortHook = vm.dump(
          vm.evalCode(
            `!!(globalThis.__abortSignals && globalThis.__abortSignals[${cidJs}])`
          )
        );
        if (isAbortHook) {
          const rawAbortPayload = eventData?.payload;
          if (rawAbortPayload instanceof Uint8Array) {
            const decrypted = await prepareBytesForVM(
              rawAbortPayload,
              encryptionKey
            );
            const payloadHandle = serde.deserialize(decrypted);
            vm.setProp(vm.global, '__tmp_abort', payloadHandle);
            payloadHandle.dispose();
            vm.evalCode(
              `(function(){` +
                `var p=globalThis.__tmp_abort;` +
                `delete globalThis.__tmp_abort;` +
                `globalThis.__abortSignals[${cidJs}]._setAborted(p&&typeof p==="object"?p.reason:undefined);` +
                `})()`
            ).dispose();
          } else {
            vm.evalCode(
              `globalThis.__abortSignals[${cidJs}]._setAborted(undefined);`
            ).dispose();
          }
          // The abort is durably recorded — clear the pending op's
          // abortRequested marker so the host doesn't re-record it (the
          // workflow's own abort() call can set the flag before this
          // event is processed when it happens later in replay order,
          // and hook_received events are not unique per correlationId).
          vm.evalCode(
            `(function(){` +
              `var p=globalThis.__pending.find(function(q){return q.correlationId===${JSON.stringify(cid)}&&q.type==="hook";});` +
              `if(p)p.abortRequested=false;` +
              `})()`
          ).dispose();
          if (event.eventId) {
            vm.evalCode(
              `(globalThis.__hookPayloadBuffer.__processedEventIds = globalThis.__hookPayloadBuffer.__processedEventIds || {})[${JSON.stringify(event.eventId)}] = true;`
            ).dispose();
          }
          {
            resolved = true;
            let b: number;
            do {
              b = vm.executePendingJobs();
            } while (b > 0);
          }
          markCreated(vm, cidJs);
          break;
        }

        const hasResolver = vm.dump(
          vm.evalCode(`!!globalThis.__resolvers[${cidJs}]`)
        );
        const rawPayload = eventData?.payload ?? eventData?.result;
        runtimeLogger.debug('QuickJS runtime: processing hook_received', {
          correlationId: cid,
          eventId: event.eventId,
          hasResolver,
          payloadType: typeof rawPayload,
          payloadIsUint8Array: rawPayload instanceof Uint8Array,
          payloadKeys:
            rawPayload && typeof rawPayload === 'object'
              ? Object.keys(rawPayload)
              : undefined,
        });
        if (hasResolver) {
          if (rawPayload instanceof Uint8Array) {
            // Decrypt if encrypted — the VM only understands 'devl' format
            const decryptedPayload = await prepareBytesForVM(
              rawPayload,
              encryptionKey
            );
            const payloadHandle = serde.deserialize(decryptedPayload);
            vm.setProp(vm.global, '__tmp_result', payloadHandle);
            payloadHandle.dispose();
            vm.evalCode(
              `globalThis.__resolvers[${cidJs}].resolve(globalThis.__tmp_result);` +
                `delete globalThis.__resolvers[${cidJs}];` +
                `delete globalThis.__tmp_result;`
            ).dispose();
          } else {
            const serialized =
              rawPayload !== undefined
                ? JSON.stringify(rawPayload)
                : 'undefined';
            vm.evalCode(
              `globalThis.__resolvers[${cidJs}].resolve(${serialized});` +
                `delete globalThis.__resolvers[${cidJs}];`
            ).dispose();
          }
          // Mark this event as processed in the VM heap to prevent
          // double-delivery when the outer loop re-scans events.
          if (event.eventId) {
            vm.evalCode(
              `(globalThis.__hookPayloadBuffer.__processedEventIds = globalThis.__hookPayloadBuffer.__processedEventIds || {})[${JSON.stringify(event.eventId)}] = true;`
            ).dispose();
          }
          {
            resolved = true;
            let b: number;
            do {
              b = vm.executePendingJobs();
            } while (b > 0);
          }
        } else {
          // No resolver yet — buffer the payload in the VM heap. When
          // createHookPromise() is called later, it will drain this buffer
          // first (matching the node:vm engine's payloadsQueue behavior).
          const eventIdJs = event.eventId
            ? JSON.stringify(event.eventId)
            : 'null';
          const bufferAndTrack =
            `(globalThis.__hookPayloadBuffer[${cidJs}] = globalThis.__hookPayloadBuffer[${cidJs}] || [])` +
            `.push(%PAYLOAD%);` +
            (event.eventId
              ? `(globalThis.__hookPayloadBuffer.__processedEventIds = globalThis.__hookPayloadBuffer.__processedEventIds || {})[${eventIdJs}] = true;`
              : '');
          if (rawPayload instanceof Uint8Array) {
            // Decrypt if encrypted — the VM only understands 'devl' format
            const decryptedPayload = await prepareBytesForVM(
              rawPayload,
              encryptionKey
            );
            const payloadHandle = serde.deserialize(decryptedPayload);
            vm.setProp(vm.global, '__tmp_result', payloadHandle);
            payloadHandle.dispose();
            // NOTE: replacement is a function so `$`-sequences in the
            // substituted JS never get interpreted as String.replace
            // special replacement patterns.
            vm.evalCode(
              bufferAndTrack.replace(
                '%PAYLOAD%',
                () => 'globalThis.__tmp_result'
              ) + 'delete globalThis.__tmp_result;'
            ).dispose();
          } else {
            const serialized =
              rawPayload !== undefined
                ? JSON.stringify(rawPayload)
                : 'undefined';
            // Function replacement: a JSON-serialized payload can contain
            // `$&`, `$'`, `$\``, ... which String.replace would otherwise
            // expand, silently corrupting the injected code.
            vm.evalCode(
              bufferAndTrack.replace('%PAYLOAD%', () => serialized)
            ).dispose();
          }
        }
        markCreated(vm, cidJs);
        break;
      }
      case 'hook_conflict': {
        // Another workflow owns this hook token. Payload awaiters reject
        // with HookConflictError; getConflict() awaiters resolve with a
        // Run handle for the conflicting run (revived through the VM's
        // class registry so its methods are durable step proxies) or
        // reject with the error when no handle can be constructed —
        // mirroring the node:vm engine's hook.ts hook_conflict handling.
        const conflictToken = (eventData?.token as string) ?? 'unknown';
        const conflictingRunId = eventData?.conflictingRunId as
          | string
          | undefined;
        const didSettle = vm.dump(
          vm.evalCode(
            `(function(){
              var cid = ${JSON.stringify(cid)};
              var token = ${JSON.stringify(conflictToken)};
              var conflictingRunId = ${JSON.stringify(conflictingRunId ?? null)};
              var ErrCls = globalThis[Symbol.for('@workflow/errors//HookConflictError')];
              var err;
              if (typeof ErrCls === 'function') {
                err = new ErrCls(token, conflictingRunId || undefined);
              } else {
                err = new Error('Hook token "' + token + '" is already in use by another workflow');
                err.name = 'HookConflictError';
                err.token = token;
                if (conflictingRunId) err.conflictingRunId = conflictingRunId;
              }
              var run = null;
              if (conflictingRunId) {
                var reg = globalThis[Symbol.for('workflow-class-registry')];
                var RunCls = reg && reg.get('class//workflow//Run');
                var des = RunCls && RunCls[Symbol.for('workflow-deserialize')];
                if (typeof des === 'function') {
                  run = des.call(RunCls, { runId: conflictingRunId });
                }
              }
              var settled = false;
              var state = globalThis.__hooks && globalThis.__hooks[cid];
              if (state && !state.conflict) {
                state.conflict = { error: err, run: run };
                var gc = state.getConflictResolvers;
                state.getConflictResolvers = [];
                for (var i = 0; i < gc.length; i++) {
                  if (run) { gc[i].resolve(run); } else { gc[i].reject(err); }
                  settled = true;
                }
              }
              if (globalThis.__resolvers[cid]) {
                globalThis.__resolvers[cid].reject(err);
                delete globalThis.__resolvers[cid];
                settled = true;
              }
              return settled;
            })()`
          )
        );
        if (didSettle) {
          resolved = true;
          let b: number;
          do {
            b = vm.executePendingJobs();
          } while (b > 0);
        }
        markCreated(vm, cidJs);
        break;
      }
      case 'step_created':
      case 'step_started':
      case 'step_retrying':
      case 'wait_created': {
        markCreated(vm, cidJs);
        break;
      }
      case 'hook_created': {
        // Confirm creation for getConflict() awaiters: resolve them with
        // null (no conflict) once the event log proves the hook exists.
        const settledGetConflict = vm.dump(
          vm.evalCode(
            `(function(){
              var state = globalThis.__hooks && globalThis.__hooks[${JSON.stringify(cid)}];
              if (!state) return false;
              state.created = true;
              var gc = state.getConflictResolvers;
              state.getConflictResolvers = [];
              for (var i = 0; i < gc.length; i++) gc[i].resolve(null);
              return gc.length > 0;
            })()`
          )
        );
        if (settledGetConflict) {
          resolved = true;
          let b: number;
          do {
            b = vm.executePendingJobs();
          } while (b > 0);
        }
        markCreated(vm, cidJs);
        break;
      }
      case 'hook_disposed': {
        // Disambiguate from the `hook` pending op with the same
        // correlationId — we want to mark the `hook_dispose` entry.
        markCreated(vm, cidJs, 'hook_dispose');
        break;
      }
    }
  }
  return resolved;
}

function markCreated(vm: QuickJS, cidJs: string, opType?: string): void {
  // `cidJs` is the JSON.stringify-quoted correlation id (see processEvents).
  // `hook` and `hook_dispose` pending ops share the same correlationId,
  // so when processing `hook_disposed` events we must disambiguate by
  // type — otherwise `.find()` returns the original `hook` op and the
  // `hook_dispose` op is never marked, causing the entrypoint to keep
  // retrying a hook_disposed for an already-deleted entity.
  const predicate = opType
    ? `function(p){return p.correlationId===${cidJs}&&p.type===${JSON.stringify(opType)};}`
    : `function(p){return p.correlationId===${cidJs};}`;
  vm.evalCode(
    `var __p=globalThis.__pending.find(${predicate});` +
      `if(__p)__p.hasCreatedEvent=true;`
  ).dispose();
}

// ---- State Checking ----

/**
 * Collect leftover pending operations that need durable side effects when
 * the workflow reaches a terminal state. Mirrors the node:vm engine's
 * drainPendingQueueItems (workflow.ts): still-alive system hooks
 * (AbortController) without an abort in flight are implicitly disposed so
 * they don't leak hook rows; ops without created events (fire-and-forget
 * attributes/hooks/steps/waits) and pending abort recordings are surfaced
 * for the entrypoint to flush.
 */
/**
 * Per-VM cache of serialized pending-op field bytes, keyed
 * `correlationId:field`. A step's raw input is immutable once pushed, so
 * its bytes are computed once even though the op is re-collected on every
 * suspension it stays pending through.
 */
const pendingByteCache = new WeakMap<QuickJS, Map<string, Uint8Array>>();

function ensurePendingByteCache(vm: QuickJS): Map<string, Uint8Array> {
  let cache = pendingByteCache.get(vm);
  if (!cache) {
    cache = new Map();
    pendingByteCache.set(vm, cache);
  }
  return cache;
}

/**
 * The pending-op fields that hold RAW guest values (the bootstrap no longer
 * serializes them in the VM). Collection projects them out of the dumped
 * plain metadata and serializes each through a handle with the host serde.
 */
const RAW_PENDING_FIELDS = ['input', 'metadata', 'abortPayload'] as const;

/**
 * Dump a filtered view of `globalThis.__pending` to host PendingOperation
 * objects, serializing the raw-value fields host-side. `filterExpr` is a
 * guest expression that evaluates to the array of ops to collect.
 */
function dumpPendingOps(
  vm: QuickJS,
  serde: QuickJSSerde,
  filterExpr: string,
  byteCache?: Map<string, Uint8Array>
): PendingOperation[] {
  using projected = vm.evalCode(`(function(){
    var ops = ${filterExpr};
    globalThis.__rawFields = [];
    return ops.map(function(p){
      var q = {};
      for (var k in p) {
        if (k === 'input' || k === 'metadata' || k === 'abortPayload') continue;
        q[k] = p[k];
      }
      var raw = {};
      ['input', 'metadata', 'abortPayload'].forEach(function(f){
        if (p[f] !== undefined) {
          raw[f] = globalThis.__rawFields.length;
          globalThis.__rawFields.push(p[f]);
        }
      });
      q.__rawIndices = raw;
      return q;
    });
  })()`);
  const plainOps = vm.dump(projected) as (PendingOperation & {
    __rawIndices?: Record<string, number>;
  })[];
  using rawFields = vm.evalCode('globalThis.__rawFields');
  for (const op of plainOps) {
    const rawIndices = op.__rawIndices ?? {};
    delete op.__rawIndices;
    for (const field of RAW_PENDING_FIELDS) {
      const index = rawIndices[field];
      if (index === undefined) continue;
      const cacheKey = `${op.correlationId}:${field}`;
      let bytes = byteCache?.get(cacheKey);
      if (!bytes) {
        using valueHandle = rawFields.getProp(String(index));
        bytes = serde.serialize(valueHandle);
        byteCache?.set(cacheKey, bytes);
      }
      (op as unknown as Record<string, unknown>)[field] = bytes;
    }
  }
  vm.evalCode('delete globalThis.__rawFields').dispose();
  return plainOps;
}

function collectDrainOperations(
  vm: QuickJS,
  serde: QuickJSSerde
): PendingOperation[] {
  return dumpPendingOps(
    vm,
    serde,
    `(function(){
    var toDispose = [];
    globalThis.__pending.forEach(function(p){
      if (p.type === "hook" && p.isSystem && !p.abortRequested && !p.disposed) {
        p.disposed = true;
        // Only dispose hooks that were durably created; a hook that never
        // reached storage has nothing to clean up.
        if (p.hasCreatedEvent) {
          toDispose.push({
            type: "hook_dispose",
            correlationId: p.correlationId,
            hasCreatedEvent: false,
          });
        }
      }
    });
    toDispose.forEach(function(d){ globalThis.__pending.push(d); });
    return globalThis.__pending.filter(function(p){
      if (p.abortRequested) return true;
      if (p.hasCreatedEvent) return false;
      // Skip system hooks that were disposed before ever being created.
      if (p.type === "hook" && p.disposed) return false;
      return true;
    });
  })()`
  );
}

function checkWorkflowState(
  vm: QuickJS,
  serde: QuickJSSerde,
  opts: { keepAliveOnSuspend?: boolean } = {}
): QuickJSRuntimeResult {
  // Check completed — __workflowResult holds the RAW return value (with a
  // separate done flag so `undefined` results are distinguishable); the
  // host serializes it through a handle.
  {
    using done = vm.evalCode('globalThis.__workflowDone === true');
    if (done.toBoolean()) {
      using h = vm.evalCode('globalThis.__workflowResult');
      const resultBytes = serde.serialize(h);
      const drainOperations = collectDrainOperations(vm, serde);
      vm.dispose();
      return {
        completed: {
          result: resultBytes,
          ...(drainOperations.length > 0 ? { drainOperations } : {}),
        },
      };
    }
  }

  // Check failed
  {
    using h = vm.evalCode('globalThis.__workflowError');
    if (!h.isUndefined) {
      // The display fields are plain strings; the thrown value itself is
      // RAW and serialized host-side through a handle.
      const errorObj = h.isString
        ? (h.toString() as string)
        : (() => {
            using plain = vm.evalCode(
              '(function(e){return {message: e.message, stack: e.stack, name: e.name};})(globalThis.__workflowError)'
            );
            return vm.dump(plain) as {
              message: string;
              stack?: string;
              name?: string;
            };
          })();
      let valueBytes: Uint8Array | undefined;
      if (!h.isString) {
        using rawValue = h.getProp('value');
        try {
          valueBytes = serde.serialize(rawValue);
        } catch (serializeErr) {
          // A thrown value the codec cannot serialize must not mask the
          // workflow failure itself — fall back to the display fields.
          runtimeLogger.warn(
            'QuickJS runtime: failed to serialize thrown workflow error',
            {
              message:
                serializeErr instanceof Error
                  ? serializeErr.message
                  : String(serializeErr),
            }
          );
        }
      }
      const failed =
        typeof errorObj === 'string'
          ? { message: errorObj }
          : {
              message: errorObj.message,
              stack: errorObj.stack || undefined,
              name: errorObj.name || undefined,
              valueBytes,
            };
      runtimeLogger.error('QuickJS runtime: workflow failed in VM', {
        errorMessage: failed.message,
        errorName: failed.name,
        errorStack: failed.stack,
      });
      const drainOperations = collectDrainOperations(vm, serde);
      vm.dispose();
      return {
        failed: {
          ...failed,
          ...(drainOperations.length > 0 ? { drainOperations } : {}),
        },
      };
    }
  }

  // Check suspended — the workflow is suspended if there are active resolvers
  // OR pending operations that haven't been created yet (e.g. hooks created
  // upfront but not yet awaited)
  {
    using h = vm.evalCode(
      'Object.keys(globalThis.__resolvers).length > 0 || globalThis.__pending.some(function(p){return!p.hasCreatedEvent;})'
    );
    if (vm.dump(h)) {
      // Ops with an active resolver or without a created event are
      // pending; abort-requested hooks are also surfaced (even when
      // already created and unawaited) so the host records the abort.
      const pendingOps = dumpPendingOps(
        vm,
        serde,
        `globalThis.__pending.filter(function(p){return!!globalThis.__resolvers[p.correlationId] || !p.hasCreatedEvent || p.abortRequested;})`,
        ensurePendingByteCache(vm)
      );
      if (!opts.keepAliveOnSuspend) vm.dispose();

      return {
        suspended: {
          pendingOperations: pendingOps,
        },
      };
    }
  }

  vm.dispose();
  return { failed: { message: 'Workflow ended in unknown state' } };
}

// ---- Helpers ----

function extractError(
  vm: QuickJS,
  err: unknown,
  fallbackMessage: string
): QuickJSRuntimeResult {
  let message = fallbackMessage;
  let stack: string | undefined;
  let name: string | undefined;

  if (err instanceof JSException) {
    const error = vm.dump(err.handle) as Record<string, unknown> | null;
    err.handle.dispose();
    message = (error?.message as string) ?? err.message ?? fallbackMessage;
    stack = (error?.stack as string) ?? err.stack;
    name = (error?.name as string) ?? err.name;
  } else if (err instanceof Error) {
    message = err.message ?? fallbackMessage;
    stack = err.stack;
    name = err.name;
  }

  vm.dispose();
  return {
    failed: { message, stack, name },
  };
}

/**
 * Mutable interrupt budget for a VM. QuickJS polls the interrupt handler
 * during JS execution; when it returns true, execution aborts. The budget
 * bounds a single host->VM execution burst (bundle eval + event
 * processing), not total VM lifetime — the inline-step loop keeps a VM
 * alive across step executions that can legitimately take minutes, so the
 * host resets the budget before each re-entry (see resetBudget calls).
 *
 * The per-burst ceiling is the same configurable budget as the node
 * engine's ReplayBudget (REPLAY_TIMEOUT_MS, default 240s): a workflow
 * whose replay the node engine handles fine must not be interrupted here
 * by a lower hardcoded ceiling. The interrupt error escapes
 * runQuickJSWorkflow and reaches the replay loop's catch in runtime.ts,
 * which records run_failed.
 */
interface InterruptBudget {
  start: number;
}

function createInterruptHandler(budget: InterruptBudget): () => boolean {
  const timeout = getReplayTimeoutMs();
  return () => Date.now() - budget.start > timeout;
}
