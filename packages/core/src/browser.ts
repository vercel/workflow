/**
 * Browser build of the `workflow` package's root exports.
 *
 * Workflows and steps never run in a browser, but client code can still reach
 * `workflow`: a shared module that calls `defineHook()` at module scope, or a
 * library such as `@ai-sdk/workflow` whose entry also exports client helpers.
 * The host entry (`./index.ts`) pulls in the world, `node:async_hooks` and
 * other server-only modules, which fails a browser build. The `workflow`
 * package resolves its root to this file under the `browser` export condition.
 *
 * It has the same runtime exports as `./index.ts` (`browser.test.ts` checks
 * this). The error classes are the real ones. Every function that needs a
 * workflow or step throws `NotInWorkflowOrStepContextError` when called, and
 * `defineHook()` returns a hook whose methods throw, so defining a hook at
 * module scope still works. Keep this file free of server-only imports.
 */

import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { Hook as HookEntity } from '@workflow/world';
import {
  type DocsUrl,
  NotInWorkflowOrStepContextError,
} from './context-violation-error.js';
import type {
  Hook,
  HookOptions,
  createHook as hostCreateHook,
  createWebhook as hostCreateWebhook,
} from './create-hook.js';
import type { TypedHook } from './define-hook.js';
import type { setAttributes as hostSetAttributes } from './set-attributes.js';
import type { sleep as hostSleep } from './sleep.js';
import type { getStepMetadata as hostGetStepMetadata } from './step/get-step-metadata.js';
import type { getWorkflowMetadata as hostGetWorkflowMetadata } from './step/get-workflow-metadata.js';
import type { getWritable as hostGetWritable } from './step/writable-stream.js';

export { FatalError, RetryableError } from '@workflow/errors';

const DOCS = 'https://workflow-sdk.dev/docs/api-reference/workflow';

function notInContext(functionName: string, page: string): never {
  throw new NotInWorkflowOrStepContextError(
    functionName,
    `${DOCS}/${page}` as DocsUrl
  );
}

export const createHook: typeof hostCreateHook = () =>
  notInContext('createHook()', 'create-hook');

export const createWebhook: typeof hostCreateWebhook = () =>
  notInContext('createWebhook()', 'create-webhook');

export function defineHook<TInput, TOutput = TInput>(
  _options: { schema?: StandardSchemaV1<TInput, TOutput> } = {}
): TypedHook<TInput, TOutput> {
  return {
    create(_hookOptions?: HookOptions): Hook<TOutput> {
      return notInContext('defineHook().create()', 'define-hook');
    },
    async resume(_token: string, _payload: TInput): Promise<HookEntity> {
      return notInContext('defineHook().resume()', 'define-hook');
    },
  };
}

export const setAttributes: typeof hostSetAttributes = async () =>
  notInContext('setAttributes()', 'set-attributes');

export const sleep: typeof hostSleep = (async () =>
  notInContext('sleep()', 'sleep')) as typeof hostSleep;

export const getStepMetadata: typeof hostGetStepMetadata = () =>
  notInContext('getStepMetadata()', 'get-step-metadata');

export const getWorkflowMetadata: typeof hostGetWorkflowMetadata = () =>
  notInContext('getWorkflowMetadata()', 'get-workflow-metadata');

export const getWritable: typeof hostGetWritable = () =>
  notInContext('getWritable()', 'get-writable');
