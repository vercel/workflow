// biome-ignore-all lint: generated file
/* eslint-disable */

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
    isNodeMode || !mod || !mod.__esModule
      ? __defProp(target, 'default', { value: mod, enumerable: true })
      : target,
    mod
  )
);

// ../../node_modules/.pnpm/ms@2.1.3/node_modules/ms/index.js
var require_ms = __commonJS({
  '../../node_modules/.pnpm/ms@2.1.3/node_modules/ms/index.js'(
    exports,
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
    function fmtShort(ms3) {
      var msAbs = Math.abs(ms3);
      if (msAbs >= d) {
        return Math.round(ms3 / d) + 'd';
      }
      if (msAbs >= h) {
        return Math.round(ms3 / h) + 'h';
      }
      if (msAbs >= m) {
        return Math.round(ms3 / m) + 'm';
      }
      if (msAbs >= s) {
        return Math.round(ms3 / s) + 's';
      }
      return ms3 + 'ms';
    }
    __name(fmtShort, 'fmtShort');
    function fmtLong(ms3) {
      var msAbs = Math.abs(ms3);
      if (msAbs >= d) {
        return plural(ms3, msAbs, d, 'day');
      }
      if (msAbs >= h) {
        return plural(ms3, msAbs, h, 'hour');
      }
      if (msAbs >= m) {
        return plural(ms3, msAbs, m, 'minute');
      }
      if (msAbs >= s) {
        return plural(ms3, msAbs, s, 'second');
      }
      return ms3 + ' ms';
    }
    __name(fmtLong, 'fmtLong');
    function plural(ms3, msAbs, n, name) {
      var isPlural = msAbs >= n * 1.5;
      return Math.round(ms3 / n) + ' ' + name + (isPlural ? 's' : '');
    }
    __name(plural, 'plural');
  },
});

// ../../packages/workflow/dist/internal/builtins.js
import { registerStepFunction } from 'workflow/internal/private';
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

// ../example/workflows/3_streams.ts
import { registerStepFunction as registerStepFunction2 } from 'workflow/internal/private';
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
async function consumeStreams(...streams) {
  const parts = [];
  console.log('Consuming streams', streams);
  await Promise.all(
    streams.map(async (s, i) => {
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
registerStepFunction2(
  'step//example/workflows/3_streams.ts//genStream',
  genStream
);
registerStepFunction2(
  'step//example/workflows/3_streams.ts//consumeStreams',
  consumeStreams
);

// ../example/workflows/2_control_flow.ts
import { registerStepFunction as registerStepFunction4 } from 'workflow/internal/private';

// ../../packages/errors/dist/index.js
var import_ms = __toESM(require_ms(), 1);
var FatalError = class extends Error {
  static {
    __name(this, 'FatalError');
  }
  fatal = true;
  constructor(message) {
    super(message);
    this.name = 'FatalError';
  }
};
var RetryableError = class extends Error {
  static {
    __name(this, 'RetryableError');
  }
  /**
   * The Date when the step should be retried.
   */
  retryAfter;
  constructor(message, options = {}) {
    super(message);
    this.name = 'RetryableError';
    let retryAfterSeconds;
    if (typeof options.retryAfter === 'string') {
      retryAfterSeconds = (0, import_ms.default)(options.retryAfter) / 1e3;
    } else if (typeof options.retryAfter === 'number') {
      retryAfterSeconds = options.retryAfter;
    } else if (options.retryAfter instanceof Date) {
      retryAfterSeconds = (options.retryAfter.getTime() - Date.now()) / 1e3;
    } else {
      retryAfterSeconds = 1;
    }
    this.retryAfter = new Date(Date.now() + retryAfterSeconds * 1e3);
  }
};

// ../../packages/core/dist/index.js
import {
  createHook,
  createWebhook,
} from '../../../packages/core/dist/create-hook.js';
import { defineHook } from '../../../packages/core/dist/define-hook.js';
import { getStepMetadata } from '../../../packages/core/dist/step/get-step-metadata.js';
import { getWorkflowMetadata } from '../../../packages/core/dist/step/get-workflow-metadata.js';
import { getWritable } from '../../../packages/core/dist/writable-stream.js';

// ../../packages/workflow/dist/stdlib.js
import { registerStepFunction as registerStepFunction3 } from 'workflow/internal/private';
var import_ms2 = __toESM(require_ms(), 1);
var MAX_SLEEP_DURATION_SECONDS = (0, import_ms2.default)('23h') / 1e3;
async function sleep(param) {
  const { stepStartedAt } = getStepMetadata();
  const durationMs =
    typeof param === 'string'
      ? (0, import_ms2.default)(param)
      : param.getTime() - Number(stepStartedAt);
  if (typeof durationMs !== 'number' || durationMs < 0) {
    const message =
      param instanceof Date
        ? `Invalid sleep date: "${param}". Expected a future date.`
        : `Invalid sleep duration: "${param}". Expected a valid duration string like "1s", "1m", "1h", etc.`;
    throw new Error(message);
  }
  const endAt = +stepStartedAt + durationMs;
  const now = Date.now();
  if (now < endAt) {
    const remainingSeconds = (endAt - now) / 1e3;
    const retryAfter = Math.min(remainingSeconds, MAX_SLEEP_DURATION_SECONDS);
    throw new RetryableError(
      `Sleeping for ${(0, import_ms2.default)(retryAfter * 1e3, {
        long: true,
      })}`,
      {
        retryAfter,
      }
    );
  }
}
__name(sleep, 'sleep');
sleep.maxRetries = Infinity;
async function fetch(...args) {
  return globalThis.fetch(...args);
}
__name(fetch, 'fetch');
registerStepFunction3('step//packages/workflow/dist/stdlib.js//sleep', sleep);
registerStepFunction3('step//packages/workflow/dist/stdlib.js//fetch', fetch);

// ../example/workflows/2_control_flow.ts
async function delayedMessage(ms3, message) {
  console.log(`Sleeping for ${ms3}ms and returning ${message}`);
  await new Promise((resolve) => setTimeout(resolve, ms3));
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
registerStepFunction4(
  'step//example/workflows/2_control_flow.ts//delayedMessage',
  delayedMessage
);
registerStepFunction4('step//example/workflows/2_control_flow.ts//add', add);
registerStepFunction4(
  'step//example/workflows/2_control_flow.ts//failingStep',
  failingStep
);
registerStepFunction4(
  'step//example/workflows/2_control_flow.ts//retryableStep',
  retryableStep
);

// ../example/workflows/4_ai.ts
import { registerStepFunction as registerStepFunction5 } from 'workflow/internal/private';
import { generateText, stepCountIs } from 'ai';
import z from 'zod/v4';
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
registerStepFunction5(
  'step//example/workflows/4_ai.ts//getWeatherInformation',
  getWeatherInformation
);

// ../example/workflows/5_hooks.ts
import { registerStepFunction as registerStepFunction6 } from 'workflow/internal/private';
import OpenAI from 'openai';
async function stepWithGetMetadata() {
  const ctx = getStepMetadata();
  console.log('step context', ctx);
  if (Math.random() < 0.5) {
    throw new Error('Retryable error');
  }
}
__name(stepWithGetMetadata, 'stepWithGetMetadata');
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
registerStepFunction6(
  'step//example/workflows/5_hooks.ts//stepWithGetMetadata',
  stepWithGetMetadata
);
registerStepFunction6(
  'step//example/workflows/5_hooks.ts//initiateOpenAIResponse',
  initiateOpenAIResponse
);
registerStepFunction6(
  'step//example/workflows/5_hooks.ts//getOpenAIResponse',
  getOpenAIResponse
);

// workflows/0_demo.ts
import { registerStepFunction as registerStepFunction7 } from 'workflow/internal/private';
async function pow(a) {
  console.log('Running step pow with arg:', a);
  return a * a;
}
__name(pow, 'pow');
registerStepFunction7('step//workflows/0_demo.ts//pow', pow);

// ../example/workflows/6_batching.ts
import { registerStepFunction as registerStepFunction8 } from 'workflow/internal/private';
import chunk from 'lodash.chunk';
async function logItem(item) {
  console.log(item, Date.now());
}
__name(logItem, 'logItem');
async function processItems(items) {
  await Promise.all(
    items.map(async (item) => {
      console.log(item, Date.now());
    })
  );
}
__name(processItems, 'processItems');
registerStepFunction8(
  'step//example/workflows/6_batching.ts//logItem',
  logItem
);
registerStepFunction8(
  'step//example/workflows/6_batching.ts//processItems',
  processItems
);

// ../example/workflows/98_duplicate_case.ts
import { registerStepFunction as registerStepFunction9 } from 'workflow/internal/private';
async function add2(a, b) {
  return a + b;
}
__name(add2, 'add');
registerStepFunction9(
  'step//example/workflows/98_duplicate_case.ts//add',
  add2
);

// ../example/workflows/1_simple.ts
import { registerStepFunction as registerStepFunction10 } from 'workflow/internal/private';
async function add3(a, b) {
  if (Math.random() < 0.5) {
    throw new Error('Retryable error');
  }
  if (Math.random() < 0.05) {
    throw new FatalError("We're cooked yo!");
  }
  return a + b;
}
__name(add3, 'add');
registerStepFunction10('step//example/workflows/1_simple.ts//add', add3);

// ../example/workflows/99_e2e.ts
import { registerStepFunction as registerStepFunction11 } from 'workflow/internal/private';
async function add4(a, b) {
  return a + b;
}
__name(add4, 'add');
async function randomDelay(v) {
  await new Promise((resolve) => setTimeout(resolve, Math.random() * 3e3));
  return v.toUpperCase();
}
__name(randomDelay, 'randomDelay');
async function specificDelay(delay, v) {
  await new Promise((resolve) => setTimeout(resolve, delay));
  return v.toUpperCase();
}
__name(specificDelay, 'specificDelay');
async function stepThatFails() {
  throw new FatalError('step failed');
}
__name(stepThatFails, 'stepThatFails');
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
async function sendWebhookResponse(req) {
  const body = await req.text();
  await req.respondWith(new Response('Hello from webhook!'));
  return body;
}
__name(sendWebhookResponse, 'sendWebhookResponse');
async function nullByteStep() {
  return 'null byte \0';
}
__name(nullByteStep, 'nullByteStep');
async function stepWithMetadata() {
  const stepMetadata = getStepMetadata();
  const workflowMetadata = getWorkflowMetadata();
  return {
    stepMetadata,
    workflowMetadata,
  };
}
__name(stepWithMetadata, 'stepWithMetadata');
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
async function promiseRaceStressTestDelayStep(dur, resp) {
  console.log(`sleep`, resp, `/`, dur);
  await new Promise((resolve) => setTimeout(resolve, dur));
  console.log(resp, `done`);
  return resp;
}
__name(promiseRaceStressTestDelayStep, 'promiseRaceStressTestDelayStep');
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
registerStepFunction11('step//example/workflows/99_e2e.ts//add', add4);
registerStepFunction11(
  'step//example/workflows/99_e2e.ts//randomDelay',
  randomDelay
);
registerStepFunction11(
  'step//example/workflows/99_e2e.ts//specificDelay',
  specificDelay
);
registerStepFunction11(
  'step//example/workflows/99_e2e.ts//stepThatFails',
  stepThatFails
);
registerStepFunction11(
  'step//example/workflows/99_e2e.ts//genReadableStream',
  genReadableStream
);
registerStepFunction11(
  'step//example/workflows/99_e2e.ts//sendWebhookResponse',
  sendWebhookResponse
);
registerStepFunction11(
  'step//example/workflows/99_e2e.ts//nullByteStep',
  nullByteStep
);
registerStepFunction11(
  'step//example/workflows/99_e2e.ts//stepWithMetadata',
  stepWithMetadata
);
registerStepFunction11(
  'step//example/workflows/99_e2e.ts//stepWithOutputStreamBinary',
  stepWithOutputStreamBinary
);
registerStepFunction11(
  'step//example/workflows/99_e2e.ts//stepWithOutputStreamObject',
  stepWithOutputStreamObject
);
registerStepFunction11(
  'step//example/workflows/99_e2e.ts//stepCloseOutputStream',
  stepCloseOutputStream
);
registerStepFunction11(
  'step//example/workflows/99_e2e.ts//promiseRaceStressTestDelayStep',
  promiseRaceStressTestDelayStep
);
registerStepFunction11(
  'step//example/workflows/99_e2e.ts//stepThatRetriesAndSucceeds',
  stepThatRetriesAndSucceeds
);

// virtual-entry.js
import { stepEntrypoint } from 'workflow/runtime';
export { stepEntrypoint as POST };
