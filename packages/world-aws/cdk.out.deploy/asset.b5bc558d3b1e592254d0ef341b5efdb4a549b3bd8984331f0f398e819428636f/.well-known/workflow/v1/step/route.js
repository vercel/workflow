// biome-ignore-all lint: generated file
/* eslint-disable */

var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
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
var __reExport = (target, mod, secondTarget) => (__copyProps(target, mod, "default"), secondTarget && __copyProps(secondTarget, mod, "default"));

// node_modules/workflow/dist/internal/builtins.js
import { registerStepFunction } from "workflow/internal/private";
async function __builtin_response_array_buffer(res) {
  return res.arrayBuffer();
}
__name(__builtin_response_array_buffer, "__builtin_response_array_buffer");
async function __builtin_response_json(res) {
  return res.json();
}
__name(__builtin_response_json, "__builtin_response_json");
async function __builtin_response_text(res) {
  return res.text();
}
__name(__builtin_response_text, "__builtin_response_text");
registerStepFunction("__builtin_response_array_buffer", __builtin_response_array_buffer);
registerStepFunction("__builtin_response_json", __builtin_response_json);
registerStepFunction("__builtin_response_text", __builtin_response_text);

// workflows/user-signup.ts
import { registerStepFunction as registerStepFunction3 } from "workflow/internal/private";

// node_modules/workflow/dist/index.js
var dist_exports = {};
__export(dist_exports, {
  fetch: () => fetch,
  sleep: () => sleep
});
__reExport(dist_exports, core_star);
import * as core_star from "@workflow/core";

// node_modules/workflow/dist/stdlib.js
import { registerStepFunction as registerStepFunction2 } from "workflow/internal/private";
import { RetryableError } from "@workflow/errors";
import ms from "ms";
var MAX_SLEEP_DURATION_SECONDS = ms("23h") / 1e3;
async function sleep(param) {
  const { stepStartedAt } = (0, dist_exports.getStepMetadata)();
  const durationMs = typeof param === "string" ? ms(param) : param.getTime() - Number(stepStartedAt);
  if (typeof durationMs !== "number" || durationMs < 0) {
    const message = param instanceof Date ? `Invalid sleep date: "${param}". Expected a future date.` : `Invalid sleep duration: "${param}". Expected a valid duration string like "1s", "1m", "1h", etc.`;
    throw new Error(message);
  }
  const endAt = +stepStartedAt + durationMs;
  const now = Date.now();
  if (now < endAt) {
    const remainingSeconds = (endAt - now) / 1e3;
    const retryAfter = Math.min(remainingSeconds, MAX_SLEEP_DURATION_SECONDS);
    throw new RetryableError(`Sleeping for ${ms(retryAfter * 1e3, {
      long: true
    })}`, {
      retryAfter
    });
  }
}
__name(sleep, "sleep");
sleep.maxRetries = Infinity;
async function fetch(...args) {
  return globalThis.fetch(...args);
}
__name(fetch, "fetch");
registerStepFunction2("step//node_modules/workflow/dist/stdlib.js//sleep", sleep);
registerStepFunction2("step//node_modules/workflow/dist/stdlib.js//fetch", fetch);

// workflows/user-signup.ts
async function createUser(email) {
  console.log(`Creating user with email: ${email}`);
  return {
    id: crypto.randomUUID(),
    email
  };
}
__name(createUser, "createUser");
async function sendWelcomeEmail(user) {
  console.log(`Sending welcome email to user: ${user.id}`);
  if (Math.random() < 0.3) {
    throw new Error("Retryable!");
  }
}
__name(sendWelcomeEmail, "sendWelcomeEmail");
async function sendOnboardingEmail(user) {
  if (!user.email.includes("@")) {
    throw new dist_exports.FatalError("Invalid Email");
  }
  console.log(`Sending onboarding email to user: ${user.id}`);
}
__name(sendOnboardingEmail, "sendOnboardingEmail");
registerStepFunction3("step//workflows/user-signup.ts//createUser", createUser);
registerStepFunction3("step//workflows/user-signup.ts//sendWelcomeEmail", sendWelcomeEmail);
registerStepFunction3("step//workflows/user-signup.ts//sendOnboardingEmail", sendOnboardingEmail);

// virtual-entry.js
import { stepEntrypoint } from "workflow/runtime";
export {
  stepEntrypoint as POST
};
