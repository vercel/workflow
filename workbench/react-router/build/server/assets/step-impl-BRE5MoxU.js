var _a, _b;
import {
  c as contextStorage,
  g as getWorkflowRunStreamId,
  a as getSerializeStream,
  b as getExternalReducers,
  W as WorkflowServerWritableStream,
  s as stepEntrypoint,
  r as registerStepFunction,
  d as start,
  e as getRun,
} from './server-build-CffYREgn.js';
import 'lodash.chunk';
import OpenAI from 'openai';
import 'react/jsx-runtime';
import 'node:stream';
import '@react-router/node';
import 'react-router';
import 'isbot';
import 'react-dom/server';
import 'node:fs/promises';
import 'node:util';
import 'node:child_process';
import 'zod';
import 'zod/v4';
import 'tty';
import 'util';
import 'os';
import 'node:module';
import 'node:path';
import 'node:timers/promises';
import 'events';
import 'node:crypto';
import 'node:assert';
import 'node:net';
import 'node:http';
import 'node:buffer';
import 'node:querystring';
import 'node:events';
import 'node:diagnostics_channel';
import 'node:tls';
import 'node:zlib';
import 'node:perf_hooks';
import 'node:util/types';
import 'node:url';
import 'node:async_hooks';
import 'node:console';
import 'string_decoder';
import 'node:worker_threads';
import 'node:fs';
import 'node:os';
import 'node:vm';
import 'react';
function __private_getClosureVars() {
  const ctx = contextStorage.getStore();
  if (!ctx) {
    throw new Error(
      'Closure variables can only be accessed inside a step function'
    );
  }
  return ctx.closureVars || {};
}
function getStepMetadata() {
  const ctx = contextStorage.getStore();
  if (!ctx) {
    throw new Error(
      '`getStepMetadata()` can only be called inside a step function'
    );
  }
  return ctx.stepMetadata;
}
function getWorkflowMetadata() {
  const ctx = contextStorage.getStore();
  if (!ctx) {
    throw new Error(
      '`getWorkflowMetadata()` can only be called inside a workflow or step function'
    );
  }
  return ctx.workflowMetadata;
}
function getWritable(options = {}) {
  const ctx = contextStorage.getStore();
  if (!ctx) {
    throw new Error(
      '`getWritable()` can only be called inside a workflow or step function'
    );
  }
  const { namespace } = options;
  const runId = ctx.workflowMetadata.workflowRunId;
  const name = getWorkflowRunStreamId(runId, namespace);
  const serialize = getSerializeStream(
    getExternalReducers(globalThis, ctx.ops, runId)
  );
  ctx.ops.push(
    serialize.readable.pipeTo(new WorkflowServerWritableStream(name, runId))
  );
  return serialize.writable;
}
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __name = (target, value) =>
  __defProp(target, 'name', { value, configurable: true });
var __commonJS = (cb, mod) =>
  function __require() {
    return (
      mod ||
        (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod),
      mod.exports
    );
  };
var __copyProps = (to, from, except, desc) => {
  if ((from && typeof from === 'object') || typeof from === 'function') {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, {
          get: () => from[key],
          enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable,
        });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (
  (target = mod != null ? __create(__getProtoOf(mod)) : {}),
  __copyProps(
    // If the importer is in node compatibility mode or this is not an ESM
    // file that has been converted to a CommonJS file using a Babel-
    // compatible transform (i.e. "__esModule" has not been set), then set
    // "default" to the CommonJS "module.exports" for node compatibility.
    __defProp(target, 'default', { value: mod, enumerable: true }),
    mod
  )
);
var require_ms = __commonJS({
  '../../node_modules/.pnpm/ms@2.1.3/node_modules/ms/index.js'(
    exports$1,
    module
  ) {
    var s = 1e3;
    var m = s * 60;
    var h = m * 60;
    var d = h * 24;
    var w = d * 7;
    var y = d * 365.25;
    module.exports = function (val, options) {
      options = options || {};
      var type = typeof val;
      if (type === 'string' && val.length > 0) {
        return parse(val);
      } else if (type === 'number' && isFinite(val)) {
        return options.long ? fmtLong(val) : fmtShort(val);
      }
      throw new Error(
        'val is not a non-empty string or a valid number. val=' +
          JSON.stringify(val)
      );
    };
    function parse(str) {
      str = String(str);
      if (str.length > 100) {
        return;
      }
      var match =
        /^(-?(?:\d+)?\.?\d+) *(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|years?|yrs?|y)?$/i.exec(
          str
        );
      if (!match) {
        return;
      }
      var n = parseFloat(match[1]);
      var type = (match[2] || 'ms').toLowerCase();
      switch (type) {
        case 'years':
        case 'year':
        case 'yrs':
        case 'yr':
        case 'y':
          return n * y;
        case 'weeks':
        case 'week':
        case 'w':
          return n * w;
        case 'days':
        case 'day':
        case 'd':
          return n * d;
        case 'hours':
        case 'hour':
        case 'hrs':
        case 'hr':
        case 'h':
          return n * h;
        case 'minutes':
        case 'minute':
        case 'mins':
        case 'min':
        case 'm':
          return n * m;
        case 'seconds':
        case 'second':
        case 'secs':
        case 'sec':
        case 's':
          return n * s;
        case 'milliseconds':
        case 'millisecond':
        case 'msecs':
        case 'msec':
        case 'ms':
          return n;
        default:
          return void 0;
      }
    }
    __name(parse, 'parse');
    function fmtShort(ms2) {
      var msAbs = Math.abs(ms2);
      if (msAbs >= d) {
        return Math.round(ms2 / d) + 'd';
      }
      if (msAbs >= h) {
        return Math.round(ms2 / h) + 'h';
      }
      if (msAbs >= m) {
        return Math.round(ms2 / m) + 'm';
      }
      if (msAbs >= s) {
        return Math.round(ms2 / s) + 's';
      }
      return ms2 + 'ms';
    }
    __name(fmtShort, 'fmtShort');
    function fmtLong(ms2) {
      var msAbs = Math.abs(ms2);
      if (msAbs >= d) {
        return plural(ms2, msAbs, d, 'day');
      }
      if (msAbs >= h) {
        return plural(ms2, msAbs, h, 'hour');
      }
      if (msAbs >= m) {
        return plural(ms2, msAbs, m, 'minute');
      }
      if (msAbs >= s) {
        return plural(ms2, msAbs, s, 'second');
      }
      return ms2 + ' ms';
    }
    __name(fmtLong, 'fmtLong');
    function plural(ms2, msAbs, n, name) {
      var isPlural = msAbs >= n * 1.5;
      return Math.round(ms2 / n) + ' ' + name + (isPlural ? 's' : '');
    }
    __name(plural, 'plural');
  },
});
async function __builtin_response_array_buffer(res) {
  return res.arrayBuffer();
}
__name(__builtin_response_array_buffer, '__builtin_response_array_buffer');
async function __builtin_response_json(res) {
  return res.json();
}
__name(__builtin_response_json, '__builtin_response_json');
async function __builtin_response_text(res) {
  return res.text();
}
__name(__builtin_response_text, '__builtin_response_text');
registerStepFunction(
  '__builtin_response_array_buffer',
  __builtin_response_array_buffer
);
registerStepFunction('__builtin_response_json', __builtin_response_json);
registerStepFunction('__builtin_response_text', __builtin_response_text);
var import_ms = __toESM(require_ms());
function parseDurationToDate(param) {
  if (typeof param === 'string') {
    const durationMs = (0, import_ms.default)(param);
    if (typeof durationMs !== 'number' || durationMs < 0) {
      throw new Error(
        `Invalid duration: "${param}". Expected a valid duration string like "1s", "1m", "1h", etc.`
      );
    }
    return new Date(Date.now() + durationMs);
  } else if (typeof param === 'number') {
    if (param < 0 || !Number.isFinite(param)) {
      throw new Error(
        `Invalid duration: ${param}. Expected a non-negative finite number of milliseconds.`
      );
    }
    return new Date(Date.now() + param);
  } else if (
    param instanceof Date ||
    (param && typeof param === 'object' && typeof param.getTime === 'function')
  ) {
    return param instanceof Date ? param : new Date(param.getTime());
  } else {
    throw new Error(
      `Invalid duration parameter. Expected a duration string, number (milliseconds), or Date object.`
    );
  }
}
__name(parseDurationToDate, 'parseDurationToDate');
function isError(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    'message' in value
  );
}
__name(isError, 'isError');
var FatalError =
  ((_a = class extends Error {
    fatal = true;
    constructor(message) {
      super(message);
      this.name = 'FatalError';
    }
    static is(value) {
      return isError(value) && value.name === 'FatalError';
    }
  }),
  __name(_a, 'FatalError'),
  _a);
var RetryableError =
  ((_b = class extends Error {
    /**
     * The Date when the step should be retried.
     */
    retryAfter;
    constructor(message, options = {}) {
      super(message);
      this.name = 'RetryableError';
      if (options.retryAfter !== void 0) {
        this.retryAfter = parseDurationToDate(options.retryAfter);
      } else {
        this.retryAfter = new Date(Date.now() + 1e3);
      }
    }
    static is(value) {
      return isError(value) && value.name === 'RetryableError';
    }
  }),
  __name(_b, 'RetryableError'),
  _b);
async function fetch(...args) {
  return globalThis.fetch(...args);
}
__name(fetch, 'fetch');
registerStepFunction('step//packages/workflow/dist/stdlib.js//fetch', fetch);
async function delayedMessage(ms2, message) {
  console.log(`Sleeping for ${ms2}ms and returning ${message}`);
  await new Promise((resolve) => setTimeout(resolve, ms2));
  return `${message} (sent: ${(/* @__PURE__ */ new Date()).toISOString()})`;
}
__name(delayedMessage, 'delayedMessage');
async function add(a, b) {
  console.log(
    `Adding ${a} and ${b} (sent: ${(/* @__PURE__ */ new Date()).toISOString()})`
  );
  return a + b;
}
__name(add, 'add');
async function failingStep() {
  throw new FatalError(
    `A failed step (sent: ${(/* @__PURE__ */ new Date()).toISOString()})`
  );
}
__name(failingStep, 'failingStep');
async function retryableStep() {
  const { attempt } = getStepMetadata();
  console.log('retryableStep attempt:', attempt);
  if (attempt === 1) {
    console.log(
      'Throwing retryable error - this will be retried after 5 seconds'
    );
    throw new RetryableError('Retryable error', {
      // Retry after 5 seconds
      retryAfter: '5s',
    });
  }
  console.log('Completing successfully');
  return 'Success';
}
__name(retryableStep, 'retryableStep');
async function control_flow() {
  throw new Error(
    'You attempted to execute workflow control_flow function directly. To start a workflow, use start(control_flow) from workflow/api'
  );
}
__name(control_flow, 'control_flow');
control_flow.workflowId =
  'workflow//example/workflows/2_control_flow.ts//control_flow';
registerStepFunction(
  'step//example/workflows/2_control_flow.ts//delayedMessage',
  delayedMessage
);
registerStepFunction('step//example/workflows/2_control_flow.ts//add', add);
registerStepFunction(
  'step//example/workflows/2_control_flow.ts//failingStep',
  failingStep
);
registerStepFunction(
  'step//example/workflows/2_control_flow.ts//retryableStep',
  retryableStep
);
async function add2(a, b) {
  if (Math.random() < 0.5) {
    throw new Error('Retryable error');
  }
  if (Math.random() < 0.05) {
    throw new FatalError("We're cooked yo!");
  }
  return a + b;
}
__name(add2, 'add');
async function simple(i) {
  throw new Error(
    'You attempted to execute workflow simple function directly. To start a workflow, use start(simple) from workflow/api'
  );
}
__name(simple, 'simple');
simple.workflowId = 'workflow//example/workflows/1_simple.ts//simple';
registerStepFunction('step//example/workflows/1_simple.ts//add', add2);
async function batchOverSteps() {
  throw new Error(
    'You attempted to execute workflow batchOverSteps function directly. To start a workflow, use start(batchOverSteps) from workflow/api'
  );
}
__name(batchOverSteps, 'batchOverSteps');
batchOverSteps.workflowId =
  'workflow//example/workflows/6_batching.ts//batchOverSteps';
async function logItem(item) {
  console.log(item, Date.now());
}
__name(logItem, 'logItem');
async function batchInStep() {
  throw new Error(
    'You attempted to execute workflow batchInStep function directly. To start a workflow, use start(batchInStep) from workflow/api'
  );
}
__name(batchInStep, 'batchInStep');
batchInStep.workflowId =
  'workflow//example/workflows/6_batching.ts//batchInStep';
async function processItems(items) {
  await Promise.all(
    items.map(async (item) => {
      console.log(item, Date.now());
    })
  );
}
__name(processItems, 'processItems');
registerStepFunction('step//example/workflows/6_batching.ts//logItem', logItem);
registerStepFunction(
  'step//example/workflows/6_batching.ts//processItems',
  processItems
);
async function handleUserSignup(email) {
  throw new Error(
    'You attempted to execute workflow handleUserSignup function directly. To start a workflow, use start(handleUserSignup) from workflow/api'
  );
}
__name(handleUserSignup, 'handleUserSignup');
handleUserSignup.workflowId =
  'workflow//example/workflows/7_full.ts//handleUserSignup';
async function createUser(email) {
  console.log(`Creating a new user with email: ${email}`);
  return {
    id: crypto.randomUUID(),
    email,
  };
}
__name(createUser, 'createUser');
async function sendWelcomeEmail(user) {
  console.log(`Sending welcome email to user: ${user.id}`);
}
__name(sendWelcomeEmail, 'sendWelcomeEmail');
async function sendOnboardingEmail(user, callback) {
  console.log(`Sending onboarding email to user: ${user.id}`);
  console.log(`Click this link to resolve the webhook: ${callback}`);
}
__name(sendOnboardingEmail, 'sendOnboardingEmail');
registerStepFunction(
  'step//example/workflows/7_full.ts//createUser',
  createUser
);
registerStepFunction(
  'step//example/workflows/7_full.ts//sendWelcomeEmail',
  sendWelcomeEmail
);
registerStepFunction(
  'step//example/workflows/7_full.ts//sendOnboardingEmail',
  sendOnboardingEmail
);
async function genStream() {
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      for (let i = 0; i < 30; i++) {
        const chunk2 = encoder.encode(`${i}
`);
        controller.enqueue(chunk2);
        console.log(`Enqueued number: ${i}`);
        await new Promise((resolve) => setTimeout(resolve, 2500));
      }
      controller.close();
    },
  });
  return stream;
}
__name(genStream, 'genStream');
async function consumeStreams(...streams2) {
  const parts = [];
  console.log('Consuming streams', streams2);
  await Promise.all(
    streams2.map(async (s, i) => {
      const reader = s.getReader();
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        console.log(
          `Received ${result.value.length} bytes from stream ${i}: ${JSON.stringify(new TextDecoder().decode(result.value))}`
        );
        parts.push(result.value);
      }
    })
  );
  return Buffer.concat(parts).toString('utf8');
}
__name(consumeStreams, 'consumeStreams');
async function streams() {
  throw new Error(
    'You attempted to execute workflow streams function directly. To start a workflow, use start(streams) from workflow/api'
  );
}
__name(streams, 'streams');
streams.workflowId = 'workflow//example/workflows/3_streams.ts//streams';
registerStepFunction(
  'step//example/workflows/3_streams.ts//genStream',
  genStream
);
registerStepFunction(
  'step//example/workflows/3_streams.ts//consumeStreams',
  consumeStreams
);
async function getWeatherInformation({ city }) {
  console.log('Getting the weather for city: ', city);
  if (Math.random() < 0.5) {
    throw new Error('Retryable error');
  }
  if (Math.random() < 0.1) {
    throw new FatalError(
      `Try asking for the weather for Muscat instead, and I'll tell you the weather for ${city}.`
    );
  }
  const weatherOptions = ['sunny', 'cloudy', 'rainy', 'snowy', 'windy'];
  return weatherOptions[Math.floor(Math.random() * weatherOptions.length)];
}
__name(getWeatherInformation, 'getWeatherInformation');
async function ai(prompt) {
  throw new Error(
    'You attempted to execute workflow ai function directly. To start a workflow, use start(ai) from workflow/api'
  );
}
__name(ai, 'ai');
ai.workflowId = 'workflow//example/workflows/4_ai.ts//ai';
async function agent(prompt) {
  throw new Error(
    'You attempted to execute workflow agent function directly. To start a workflow, use start(agent) from workflow/api'
  );
}
__name(agent, 'agent');
agent.workflowId = 'workflow//example/workflows/4_ai.ts//agent';
registerStepFunction(
  'step//example/workflows/4_ai.ts//getWeatherInformation',
  getWeatherInformation
);
async function doWork() {
  return 42;
}
__name(doWork, 'doWork');
async function noStepsWorkflow(input) {
  throw new Error(
    'You attempted to execute workflow noStepsWorkflow function directly. To start a workflow, use start(noStepsWorkflow) from workflow/api'
  );
}
__name(noStepsWorkflow, 'noStepsWorkflow');
noStepsWorkflow.workflowId =
  'workflow//example/workflows/97_bench.ts//noStepsWorkflow';
async function oneStepWorkflow(input) {
  throw new Error(
    'You attempted to execute workflow oneStepWorkflow function directly. To start a workflow, use start(oneStepWorkflow) from workflow/api'
  );
}
__name(oneStepWorkflow, 'oneStepWorkflow');
oneStepWorkflow.workflowId =
  'workflow//example/workflows/97_bench.ts//oneStepWorkflow';
async function tenSequentialStepsWorkflow() {
  throw new Error(
    'You attempted to execute workflow tenSequentialStepsWorkflow function directly. To start a workflow, use start(tenSequentialStepsWorkflow) from workflow/api'
  );
}
__name(tenSequentialStepsWorkflow, 'tenSequentialStepsWorkflow');
tenSequentialStepsWorkflow.workflowId =
  'workflow//example/workflows/97_bench.ts//tenSequentialStepsWorkflow';
async function tenParallelStepsWorkflow() {
  throw new Error(
    'You attempted to execute workflow tenParallelStepsWorkflow function directly. To start a workflow, use start(tenParallelStepsWorkflow) from workflow/api'
  );
}
__name(tenParallelStepsWorkflow, 'tenParallelStepsWorkflow');
tenParallelStepsWorkflow.workflowId =
  'workflow//example/workflows/97_bench.ts//tenParallelStepsWorkflow';
async function genBenchStream() {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      for (let i = 0; i < 10; i++) {
        controller.enqueue(
          encoder.encode(`${i}
`)
        );
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      controller.close();
    },
  });
}
__name(genBenchStream, 'genBenchStream');
async function doubleNumbers(stream) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const transformStream = new TransformStream({
    transform(chunk2, controller) {
      const text = decoder.decode(chunk2, {
        stream: true,
      });
      const lines = text.split('\n');
      for (const line of lines) {
        if (line.trim()) {
          const num = parseInt(line, 10);
          controller.enqueue(
            encoder.encode(`${num * 2}
`)
          );
        }
      }
    },
  });
  return stream.pipeThrough(transformStream);
}
__name(doubleNumbers, 'doubleNumbers');
async function streamWorkflow() {
  throw new Error(
    'You attempted to execute workflow streamWorkflow function directly. To start a workflow, use start(streamWorkflow) from workflow/api'
  );
}
__name(streamWorkflow, 'streamWorkflow');
streamWorkflow.workflowId =
  'workflow//example/workflows/97_bench.ts//streamWorkflow';
registerStepFunction('step//example/workflows/97_bench.ts//doWork', doWork);
registerStepFunction(
  'step//example/workflows/97_bench.ts//genBenchStream',
  genBenchStream
);
registerStepFunction(
  'step//example/workflows/97_bench.ts//doubleNumbers',
  doubleNumbers
);
async function addTenWorkflow(input) {
  throw new Error(
    'You attempted to execute workflow addTenWorkflow function directly. To start a workflow, use start(addTenWorkflow) from workflow/api'
  );
}
__name(addTenWorkflow, 'addTenWorkflow');
addTenWorkflow.workflowId =
  'workflow//example/workflows/98_duplicate_case.ts//addTenWorkflow';
async function add3(a, b) {
  return a + b;
}
__name(add3, 'add');
registerStepFunction('step//example/workflows/98_duplicate_case.ts//add', add3);
var stepFunctionWithClosureWorkflow$calculate = /* @__PURE__ */ __name(
  async (x) => {
    const { multiplier, prefix } = __private_getClosureVars();
    return `${prefix}${x * multiplier}`;
  },
  'stepFunctionWithClosureWorkflow$calculate'
);
var closureVariableWorkflow$calculate = /* @__PURE__ */ __name(async () => {
  const { baseValue, multiplier, prefix } = __private_getClosureVars();
  const result = baseValue * multiplier;
  return `${prefix}${result}`;
}, 'closureVariableWorkflow$calculate');
async function add4(a, b) {
  return a + b;
}
__name(add4, 'add');
async function addTenWorkflow2(input) {
  throw new Error(
    'You attempted to execute workflow addTenWorkflow function directly. To start a workflow, use start(addTenWorkflow) from workflow/api'
  );
}
__name(addTenWorkflow2, 'addTenWorkflow');
addTenWorkflow2.workflowId =
  'workflow//example/workflows/99_e2e.ts//addTenWorkflow';
async function nestedErrorWorkflow() {
  throw new Error(
    'You attempted to execute workflow nestedErrorWorkflow function directly. To start a workflow, use start(nestedErrorWorkflow) from workflow/api'
  );
}
__name(nestedErrorWorkflow, 'nestedErrorWorkflow');
nestedErrorWorkflow.workflowId =
  'workflow//example/workflows/99_e2e.ts//nestedErrorWorkflow';
async function randomDelay(v) {
  await new Promise((resolve) => setTimeout(resolve, Math.random() * 3e3));
  return v.toUpperCase();
}
__name(randomDelay, 'randomDelay');
async function promiseAllWorkflow() {
  throw new Error(
    'You attempted to execute workflow promiseAllWorkflow function directly. To start a workflow, use start(promiseAllWorkflow) from workflow/api'
  );
}
__name(promiseAllWorkflow, 'promiseAllWorkflow');
promiseAllWorkflow.workflowId =
  'workflow//example/workflows/99_e2e.ts//promiseAllWorkflow';
async function specificDelay(delay, v) {
  await new Promise((resolve) => setTimeout(resolve, delay));
  return v.toUpperCase();
}
__name(specificDelay, 'specificDelay');
async function promiseRaceWorkflow() {
  throw new Error(
    'You attempted to execute workflow promiseRaceWorkflow function directly. To start a workflow, use start(promiseRaceWorkflow) from workflow/api'
  );
}
__name(promiseRaceWorkflow, 'promiseRaceWorkflow');
promiseRaceWorkflow.workflowId =
  'workflow//example/workflows/99_e2e.ts//promiseRaceWorkflow';
async function stepThatFails() {
  throw new FatalError('step failed');
}
__name(stepThatFails, 'stepThatFails');
async function promiseAnyWorkflow() {
  throw new Error(
    'You attempted to execute workflow promiseAnyWorkflow function directly. To start a workflow, use start(promiseAnyWorkflow) from workflow/api'
  );
}
__name(promiseAnyWorkflow, 'promiseAnyWorkflow');
promiseAnyWorkflow.workflowId =
  'workflow//example/workflows/99_e2e.ts//promiseAnyWorkflow';
async function genReadableStream() {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      for (let i = 0; i < 10; i++) {
        console.log('enqueueing', i);
        controller.enqueue(
          encoder.encode(`${i}
`)
        );
        await new Promise((resolve) => setTimeout(resolve, 1e3));
      }
      console.log('closing controller');
      controller.close();
    },
  });
}
__name(genReadableStream, 'genReadableStream');
async function readableStreamWorkflow() {
  throw new Error(
    'You attempted to execute workflow readableStreamWorkflow function directly. To start a workflow, use start(readableStreamWorkflow) from workflow/api'
  );
}
__name(readableStreamWorkflow, 'readableStreamWorkflow');
readableStreamWorkflow.workflowId =
  'workflow//example/workflows/99_e2e.ts//readableStreamWorkflow';
async function hookWorkflow(token, customData) {
  throw new Error(
    'You attempted to execute workflow hookWorkflow function directly. To start a workflow, use start(hookWorkflow) from workflow/api'
  );
}
__name(hookWorkflow, 'hookWorkflow');
hookWorkflow.workflowId = 'workflow//example/workflows/99_e2e.ts//hookWorkflow';
async function sendWebhookResponse(req) {
  const body = await req.text();
  await req.respondWith(new Response('Hello from webhook!'));
  return body;
}
__name(sendWebhookResponse, 'sendWebhookResponse');
async function webhookWorkflow(token, token2, token3) {
  throw new Error(
    'You attempted to execute workflow webhookWorkflow function directly. To start a workflow, use start(webhookWorkflow) from workflow/api'
  );
}
__name(webhookWorkflow, 'webhookWorkflow');
webhookWorkflow.workflowId =
  'workflow//example/workflows/99_e2e.ts//webhookWorkflow';
async function sleepingWorkflow() {
  throw new Error(
    'You attempted to execute workflow sleepingWorkflow function directly. To start a workflow, use start(sleepingWorkflow) from workflow/api'
  );
}
__name(sleepingWorkflow, 'sleepingWorkflow');
sleepingWorkflow.workflowId =
  'workflow//example/workflows/99_e2e.ts//sleepingWorkflow';
async function nullByteStep() {
  return 'null byte \0';
}
__name(nullByteStep, 'nullByteStep');
async function nullByteWorkflow() {
  throw new Error(
    'You attempted to execute workflow nullByteWorkflow function directly. To start a workflow, use start(nullByteWorkflow) from workflow/api'
  );
}
__name(nullByteWorkflow, 'nullByteWorkflow');
nullByteWorkflow.workflowId =
  'workflow//example/workflows/99_e2e.ts//nullByteWorkflow';
async function stepWithMetadata() {
  const stepMetadata = getStepMetadata();
  const workflowMetadata = getWorkflowMetadata();
  return {
    stepMetadata,
    workflowMetadata,
  };
}
__name(stepWithMetadata, 'stepWithMetadata');
async function workflowAndStepMetadataWorkflow() {
  throw new Error(
    'You attempted to execute workflow workflowAndStepMetadataWorkflow function directly. To start a workflow, use start(workflowAndStepMetadataWorkflow) from workflow/api'
  );
}
__name(workflowAndStepMetadataWorkflow, 'workflowAndStepMetadataWorkflow');
workflowAndStepMetadataWorkflow.workflowId =
  'workflow//example/workflows/99_e2e.ts//workflowAndStepMetadataWorkflow';
async function stepWithOutputStreamBinary(writable, text) {
  const writer = writable.getWriter();
  await writer.write(new TextEncoder().encode(text));
  writer.releaseLock();
}
__name(stepWithOutputStreamBinary, 'stepWithOutputStreamBinary');
async function stepWithOutputStreamObject(writable, obj) {
  const writer = writable.getWriter();
  await writer.write(obj);
  writer.releaseLock();
}
__name(stepWithOutputStreamObject, 'stepWithOutputStreamObject');
async function stepCloseOutputStream(writable) {
  await writable.close();
}
__name(stepCloseOutputStream, 'stepCloseOutputStream');
async function outputStreamWorkflow() {
  throw new Error(
    'You attempted to execute workflow outputStreamWorkflow function directly. To start a workflow, use start(outputStreamWorkflow) from workflow/api'
  );
}
__name(outputStreamWorkflow, 'outputStreamWorkflow');
outputStreamWorkflow.workflowId =
  'workflow//example/workflows/99_e2e.ts//outputStreamWorkflow';
async function stepWithOutputStreamInsideStep(text) {
  const writable = getWritable();
  const writer = writable.getWriter();
  await writer.write(new TextEncoder().encode(text));
  writer.releaseLock();
}
__name(stepWithOutputStreamInsideStep, 'stepWithOutputStreamInsideStep');
async function stepWithNamedOutputStreamInsideStep(namespace, obj) {
  const writable = getWritable({
    namespace,
  });
  const writer = writable.getWriter();
  await writer.write(obj);
  writer.releaseLock();
}
__name(
  stepWithNamedOutputStreamInsideStep,
  'stepWithNamedOutputStreamInsideStep'
);
async function stepCloseOutputStreamInsideStep(namespace) {
  const writable = getWritable({
    namespace,
  });
  await writable.close();
}
__name(stepCloseOutputStreamInsideStep, 'stepCloseOutputStreamInsideStep');
async function outputStreamInsideStepWorkflow() {
  throw new Error(
    'You attempted to execute workflow outputStreamInsideStepWorkflow function directly. To start a workflow, use start(outputStreamInsideStepWorkflow) from workflow/api'
  );
}
__name(outputStreamInsideStepWorkflow, 'outputStreamInsideStepWorkflow');
outputStreamInsideStepWorkflow.workflowId =
  'workflow//example/workflows/99_e2e.ts//outputStreamInsideStepWorkflow';
async function fetchWorkflow() {
  throw new Error(
    'You attempted to execute workflow fetchWorkflow function directly. To start a workflow, use start(fetchWorkflow) from workflow/api'
  );
}
__name(fetchWorkflow, 'fetchWorkflow');
fetchWorkflow.workflowId =
  'workflow//example/workflows/99_e2e.ts//fetchWorkflow';
async function promiseRaceStressTestDelayStep(dur, resp) {
  console.log(`sleep`, resp, `/`, dur);
  await new Promise((resolve) => setTimeout(resolve, dur));
  console.log(resp, `done`);
  return resp;
}
__name(promiseRaceStressTestDelayStep, 'promiseRaceStressTestDelayStep');
async function promiseRaceStressTestWorkflow() {
  throw new Error(
    'You attempted to execute workflow promiseRaceStressTestWorkflow function directly. To start a workflow, use start(promiseRaceStressTestWorkflow) from workflow/api'
  );
}
__name(promiseRaceStressTestWorkflow, 'promiseRaceStressTestWorkflow');
promiseRaceStressTestWorkflow.workflowId =
  'workflow//example/workflows/99_e2e.ts//promiseRaceStressTestWorkflow';
async function stepThatRetriesAndSucceeds() {
  const { attempt } = getStepMetadata();
  console.log(`stepThatRetriesAndSucceeds - attempt: ${attempt}`);
  if (attempt < 3) {
    console.log(`Attempt ${attempt} - throwing error to trigger retry`);
    throw new Error(`Failed on attempt ${attempt}`);
  }
  console.log(`Attempt ${attempt} - succeeding`);
  return attempt;
}
__name(stepThatRetriesAndSucceeds, 'stepThatRetriesAndSucceeds');
async function retryAttemptCounterWorkflow() {
  throw new Error(
    'You attempted to execute workflow retryAttemptCounterWorkflow function directly. To start a workflow, use start(retryAttemptCounterWorkflow) from workflow/api'
  );
}
__name(retryAttemptCounterWorkflow, 'retryAttemptCounterWorkflow');
retryAttemptCounterWorkflow.workflowId =
  'workflow//example/workflows/99_e2e.ts//retryAttemptCounterWorkflow';
async function stepThatThrowsRetryableError() {
  const { attempt, stepStartedAt } = getStepMetadata();
  if (attempt === 1) {
    throw new RetryableError('Retryable error', {
      retryAfter: '10s',
    });
  }
  return {
    attempt,
    stepStartedAt,
    duration: Date.now() - stepStartedAt.getTime(),
  };
}
__name(stepThatThrowsRetryableError, 'stepThatThrowsRetryableError');
async function crossFileErrorWorkflow() {
  throw new Error(
    'You attempted to execute workflow crossFileErrorWorkflow function directly. To start a workflow, use start(crossFileErrorWorkflow) from workflow/api'
  );
}
__name(crossFileErrorWorkflow, 'crossFileErrorWorkflow');
crossFileErrorWorkflow.workflowId =
  'workflow//example/workflows/99_e2e.ts//crossFileErrorWorkflow';
async function retryableAndFatalErrorWorkflow() {
  throw new Error(
    'You attempted to execute workflow retryableAndFatalErrorWorkflow function directly. To start a workflow, use start(retryableAndFatalErrorWorkflow) from workflow/api'
  );
}
__name(retryableAndFatalErrorWorkflow, 'retryableAndFatalErrorWorkflow');
retryableAndFatalErrorWorkflow.workflowId =
  'workflow//example/workflows/99_e2e.ts//retryableAndFatalErrorWorkflow';
async function hookCleanupTestWorkflow(token, customData) {
  throw new Error(
    'You attempted to execute workflow hookCleanupTestWorkflow function directly. To start a workflow, use start(hookCleanupTestWorkflow) from workflow/api'
  );
}
__name(hookCleanupTestWorkflow, 'hookCleanupTestWorkflow');
hookCleanupTestWorkflow.workflowId =
  'workflow//example/workflows/99_e2e.ts//hookCleanupTestWorkflow';
async function stepFunctionPassingWorkflow() {
  throw new Error(
    'You attempted to execute workflow stepFunctionPassingWorkflow function directly. To start a workflow, use start(stepFunctionPassingWorkflow) from workflow/api'
  );
}
__name(stepFunctionPassingWorkflow, 'stepFunctionPassingWorkflow');
stepFunctionPassingWorkflow.workflowId =
  'workflow//example/workflows/99_e2e.ts//stepFunctionPassingWorkflow';
async function stepWithStepFunctionArg(stepFn) {
  const result = await stepFn(10);
  return result * 2;
}
__name(stepWithStepFunctionArg, 'stepWithStepFunctionArg');
async function doubleNumber(x) {
  return x * 2;
}
__name(doubleNumber, 'doubleNumber');
async function stepFunctionWithClosureWorkflow() {
  throw new Error(
    'You attempted to execute workflow stepFunctionWithClosureWorkflow function directly. To start a workflow, use start(stepFunctionWithClosureWorkflow) from workflow/api'
  );
}
__name(stepFunctionWithClosureWorkflow, 'stepFunctionWithClosureWorkflow');
stepFunctionWithClosureWorkflow.workflowId =
  'workflow//example/workflows/99_e2e.ts//stepFunctionWithClosureWorkflow';
async function stepThatCallsStepFn(stepFn, value) {
  const result = await stepFn(value);
  return `Wrapped: ${result}`;
}
__name(stepThatCallsStepFn, 'stepThatCallsStepFn');
async function closureVariableWorkflow(baseValue) {
  throw new Error(
    'You attempted to execute workflow closureVariableWorkflow function directly. To start a workflow, use start(closureVariableWorkflow) from workflow/api'
  );
}
__name(closureVariableWorkflow, 'closureVariableWorkflow');
closureVariableWorkflow.workflowId =
  'workflow//example/workflows/99_e2e.ts//closureVariableWorkflow';
async function childWorkflow(value) {
  throw new Error(
    'You attempted to execute workflow childWorkflow function directly. To start a workflow, use start(childWorkflow) from workflow/api'
  );
}
__name(childWorkflow, 'childWorkflow');
childWorkflow.workflowId =
  'workflow//example/workflows/99_e2e.ts//childWorkflow';
async function doubleValue(value) {
  return value * 2;
}
__name(doubleValue, 'doubleValue');
async function spawnChildWorkflow(value) {
  const childRun = await start(childWorkflow, [value]);
  return childRun.runId;
}
__name(spawnChildWorkflow, 'spawnChildWorkflow');
async function awaitWorkflowResult(runId) {
  const run = getRun(runId);
  const result = await run.returnValue;
  return result;
}
__name(awaitWorkflowResult, 'awaitWorkflowResult');
async function spawnWorkflowFromStepWorkflow(inputValue) {
  throw new Error(
    'You attempted to execute workflow spawnWorkflowFromStepWorkflow function directly. To start a workflow, use start(spawnWorkflowFromStepWorkflow) from workflow/api'
  );
}
__name(spawnWorkflowFromStepWorkflow, 'spawnWorkflowFromStepWorkflow');
spawnWorkflowFromStepWorkflow.workflowId =
  'workflow//example/workflows/99_e2e.ts//spawnWorkflowFromStepWorkflow';
registerStepFunction('step//example/workflows/99_e2e.ts//add', add4);
registerStepFunction(
  'step//example/workflows/99_e2e.ts//randomDelay',
  randomDelay
);
registerStepFunction(
  'step//example/workflows/99_e2e.ts//specificDelay',
  specificDelay
);
registerStepFunction(
  'step//example/workflows/99_e2e.ts//stepThatFails',
  stepThatFails
);
registerStepFunction(
  'step//example/workflows/99_e2e.ts//genReadableStream',
  genReadableStream
);
registerStepFunction(
  'step//example/workflows/99_e2e.ts//sendWebhookResponse',
  sendWebhookResponse
);
registerStepFunction(
  'step//example/workflows/99_e2e.ts//nullByteStep',
  nullByteStep
);
registerStepFunction(
  'step//example/workflows/99_e2e.ts//stepWithMetadata',
  stepWithMetadata
);
registerStepFunction(
  'step//example/workflows/99_e2e.ts//stepWithOutputStreamBinary',
  stepWithOutputStreamBinary
);
registerStepFunction(
  'step//example/workflows/99_e2e.ts//stepWithOutputStreamObject',
  stepWithOutputStreamObject
);
registerStepFunction(
  'step//example/workflows/99_e2e.ts//stepCloseOutputStream',
  stepCloseOutputStream
);
registerStepFunction(
  'step//example/workflows/99_e2e.ts//stepWithOutputStreamInsideStep',
  stepWithOutputStreamInsideStep
);
registerStepFunction(
  'step//example/workflows/99_e2e.ts//stepWithNamedOutputStreamInsideStep',
  stepWithNamedOutputStreamInsideStep
);
registerStepFunction(
  'step//example/workflows/99_e2e.ts//stepCloseOutputStreamInsideStep',
  stepCloseOutputStreamInsideStep
);
registerStepFunction(
  'step//example/workflows/99_e2e.ts//promiseRaceStressTestDelayStep',
  promiseRaceStressTestDelayStep
);
registerStepFunction(
  'step//example/workflows/99_e2e.ts//stepThatRetriesAndSucceeds',
  stepThatRetriesAndSucceeds
);
registerStepFunction(
  'step//example/workflows/99_e2e.ts//stepThatThrowsRetryableError',
  stepThatThrowsRetryableError
);
registerStepFunction(
  'step//example/workflows/99_e2e.ts//stepWithStepFunctionArg',
  stepWithStepFunctionArg
);
registerStepFunction(
  'step//example/workflows/99_e2e.ts//doubleNumber',
  doubleNumber
);
registerStepFunction(
  'step//example/workflows/99_e2e.ts//stepThatCallsStepFn',
  stepThatCallsStepFn
);
registerStepFunction(
  'step//example/workflows/99_e2e.ts//doubleValue',
  doubleValue
);
registerStepFunction(
  'step//example/workflows/99_e2e.ts//spawnChildWorkflow',
  spawnChildWorkflow
);
registerStepFunction(
  'step//example/workflows/99_e2e.ts//awaitWorkflowResult',
  awaitWorkflowResult
);
registerStepFunction(
  'step//example/workflows/99_e2e.ts//stepFunctionWithClosureWorkflow/calculate',
  stepFunctionWithClosureWorkflow$calculate
);
registerStepFunction(
  'step//example/workflows/99_e2e.ts//closureVariableWorkflow/calculate',
  closureVariableWorkflow$calculate
);
async function stepWithGetMetadata() {
  const ctx = getStepMetadata();
  console.log('step context', ctx);
  if (Math.random() < 0.5) {
    throw new Error('Retryable error');
  }
  return ctx;
}
__name(stepWithGetMetadata, 'stepWithGetMetadata');
async function withWorkflowMetadata() {
  throw new Error(
    'You attempted to execute workflow withWorkflowMetadata function directly. To start a workflow, use start(withWorkflowMetadata) from workflow/api'
  );
}
__name(withWorkflowMetadata, 'withWorkflowMetadata');
withWorkflowMetadata.workflowId =
  'workflow//example/workflows/5_hooks.ts//withWorkflowMetadata';
async function initiateOpenAIResponse() {
  const openai = new OpenAI();
  const resp = await openai.responses.create({
    model: 'o3',
    input: 'Write a very long novel about otters in space.',
    background: true,
  });
  console.log('OpenAI response:', resp);
  return resp.id;
}
__name(initiateOpenAIResponse, 'initiateOpenAIResponse');
async function getOpenAIResponse(respId) {
  const openai = new OpenAI();
  const resp = await openai.responses.retrieve(respId);
  return resp.output_text;
}
__name(getOpenAIResponse, 'getOpenAIResponse');
async function withCreateHook() {
  throw new Error(
    'You attempted to execute workflow withCreateHook function directly. To start a workflow, use start(withCreateHook) from workflow/api'
  );
}
__name(withCreateHook, 'withCreateHook');
withCreateHook.workflowId =
  'workflow//example/workflows/5_hooks.ts//withCreateHook';
registerStepFunction(
  'step//example/workflows/5_hooks.ts//stepWithGetMetadata',
  stepWithGetMetadata
);
registerStepFunction(
  'step//example/workflows/5_hooks.ts//initiateOpenAIResponse',
  initiateOpenAIResponse
);
registerStepFunction(
  'step//example/workflows/5_hooks.ts//getOpenAIResponse',
  getOpenAIResponse
);
const handleRequest = stepEntrypoint;
export { handleRequest };
