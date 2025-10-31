// biome-ignore-all lint: generated file
/* eslint-disable */
import { workflowEntrypoint } from 'workflow/runtime';

const workflowCode = `var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/.pnpm/ms@2.1.3/node_modules/ms/index.js
var require_ms = __commonJS({
  "node_modules/.pnpm/ms@2.1.3/node_modules/ms/index.js"(exports, module2) {
    var s = 1e3;
    var m = s * 60;
    var h = m * 60;
    var d = h * 24;
    var w = d * 7;
    var y = d * 365.25;
    module2.exports = function(val, options) {
      options = options || {};
      var type = typeof val;
      if (type === "string" && val.length > 0) {
        return parse(val);
      } else if (type === "number" && isFinite(val)) {
        return options.long ? fmtLong(val) : fmtShort(val);
      }
      throw new Error("val is not a non-empty string or a valid number. val=" + JSON.stringify(val));
    };
    function parse(str) {
      str = String(str);
      if (str.length > 100) {
        return;
      }
      var match = /^(-?(?:\\d+)?\\.?\\d+) *(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|years?|yrs?|y)?\$/i.exec(str);
      if (!match) {
        return;
      }
      var n = parseFloat(match[1]);
      var type = (match[2] || "ms").toLowerCase();
      switch (type) {
        case "years":
        case "year":
        case "yrs":
        case "yr":
        case "y":
          return n * y;
        case "weeks":
        case "week":
        case "w":
          return n * w;
        case "days":
        case "day":
        case "d":
          return n * d;
        case "hours":
        case "hour":
        case "hrs":
        case "hr":
        case "h":
          return n * h;
        case "minutes":
        case "minute":
        case "mins":
        case "min":
        case "m":
          return n * m;
        case "seconds":
        case "second":
        case "secs":
        case "sec":
        case "s":
          return n * s;
        case "milliseconds":
        case "millisecond":
        case "msecs":
        case "msec":
        case "ms":
          return n;
        default:
          return void 0;
      }
    }
    __name(parse, "parse");
    function fmtShort(ms2) {
      var msAbs = Math.abs(ms2);
      if (msAbs >= d) {
        return Math.round(ms2 / d) + "d";
      }
      if (msAbs >= h) {
        return Math.round(ms2 / h) + "h";
      }
      if (msAbs >= m) {
        return Math.round(ms2 / m) + "m";
      }
      if (msAbs >= s) {
        return Math.round(ms2 / s) + "s";
      }
      return ms2 + "ms";
    }
    __name(fmtShort, "fmtShort");
    function fmtLong(ms2) {
      var msAbs = Math.abs(ms2);
      if (msAbs >= d) {
        return plural(ms2, msAbs, d, "day");
      }
      if (msAbs >= h) {
        return plural(ms2, msAbs, h, "hour");
      }
      if (msAbs >= m) {
        return plural(ms2, msAbs, m, "minute");
      }
      if (msAbs >= s) {
        return plural(ms2, msAbs, s, "second");
      }
      return ms2 + " ms";
    }
    __name(fmtLong, "fmtLong");
    function plural(ms2, msAbs, n, name) {
      var isPlural = msAbs >= n * 1.5;
      return Math.round(ms2 / n) + " " + name + (isPlural ? "s" : "");
    }
    __name(plural, "plural");
  }
});

// workflows/user-signup.ts
var user_signup_exports = {};
__export(user_signup_exports, {
  handleUserSignup: () => handleUserSignup
});

// node_modules/.pnpm/@workflow+errors@4.0.1-beta.1/node_modules/@workflow/errors/dist/index.js
var import_ms = __toESM(require_ms(), 1);

// node_modules/.pnpm/@workflow+core@4.0.1-beta.3_@aws-sdk+client-sts@3.917.0/node_modules/@workflow/core/dist/symbols.js
var WORKFLOW_USE_STEP = Symbol.for("WORKFLOW_USE_STEP");
var WORKFLOW_CREATE_HOOK = Symbol.for("WORKFLOW_CREATE_HOOK");
var WORKFLOW_CONTEXT = Symbol.for("WORKFLOW_CONTEXT");
var WORKFLOW_GET_STREAM_ID = Symbol.for("WORKFLOW_GET_STREAM_ID");
var STREAM_NAME_SYMBOL = Symbol.for("WORKFLOW_STREAM_NAME");
var STREAM_TYPE_SYMBOL = Symbol.for("WORKFLOW_STREAM_TYPE");
var BODY_INIT_SYMBOL = Symbol.for("BODY_INIT");
var WEBHOOK_RESPONSE_WRITABLE = Symbol.for("WEBHOOK_RESPONSE_WRITABLE");

// node_modules/.pnpm/workflow@4.0.1-beta.3_@aws-sdk+client-sts@3.917.0_@babel+core@7.28.5_next@16.0.0_@babel_92db55f92493d09e7c362a15d0250466/node_modules/workflow/dist/stdlib.js
async function sleep(param) {
  return globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//node_modules/.pnpm/workflow@4.0.1-beta.3_@aws-sdk+client-sts@3.917.0_@babel+core@7.28.5_next@16.0.0_@babel_92db55f92493d09e7c362a15d0250466/node_modules/workflow/dist/stdlib.js//sleep")(param);
}
__name(sleep, "sleep");
sleep.maxRetries = Infinity;

// workflows/user-signup.ts
async function handleUserSignup(email) {
  const user = await createUser(email);
  await sendWelcomeEmail(user);
  await sleep("5s");
  await sendOnboardingEmail(user);
  return {
    userId: user.id,
    status: "onboarded"
  };
}
__name(handleUserSignup, "handleUserSignup");
async function createUser(email) {
  return globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//workflows/user-signup.ts//createUser")(email);
}
__name(createUser, "createUser");
async function sendWelcomeEmail(user) {
  return globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//workflows/user-signup.ts//sendWelcomeEmail")(user);
}
__name(sendWelcomeEmail, "sendWelcomeEmail");
async function sendOnboardingEmail(user) {
  return globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//workflows/user-signup.ts//sendOnboardingEmail")(user);
}
__name(sendOnboardingEmail, "sendOnboardingEmail");
handleUserSignup.workflowId = "workflow//workflows/user-signup.ts//handleUserSignup";

// virtual-entry.js
globalThis.__private_workflows = /* @__PURE__ */ new Map();
Object.values(user_signup_exports).map((item) => item?.workflowId && globalThis.__private_workflows.set(item.workflowId, item));
`;

export const POST = workflowEntrypoint(workflowCode);