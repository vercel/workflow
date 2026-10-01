import type { Serializable as CoreSerializable } from '@workflow/core';
import type { Serializable } from 'workflow';

declare const core: CoreSerializable;
declare const workflow: Serializable;
export const fromCore: Serializable = core;
export const fromWorkflow: CoreSerializable = workflow;
export const nested: Serializable = {
  bytes: new Uint8Array([1, 2]),
  children: [null, new Date()],
};

// @ts-expect-error Symbols are outside the existing Serializable type.
export const symbol: Serializable = Symbol();
