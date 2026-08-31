import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  AnalyticsAttributeKeySchema,
  AnalyticsEventSchema,
  AnalyticsHookSchema,
  AnalyticsRunSchema,
  AnalyticsStepSchema,
  AnalyticsWaitSchema,
} from './analytics.js';
import { AttributeChangesSchema } from './attributes.js';
import { CreateEventSchema, EventSchema } from './events.js';
import { HookSchema } from './hooks.js';
import {
  HealthCheckPayloadSchema,
  QueuePayloadSchema,
  WorkflowInvokePayloadSchema,
} from './queue.js';
import {
  BulkCancelWorkflowRunResultSchema,
  BulkCancelWorkflowRunsRequestSchema,
  BulkCancelWorkflowRunsResultSchema,
  WorkflowRunSchema,
} from './runs.js';
import { StructuredErrorSchema } from './shared.js';
import { StepSchema } from './steps.js';
import { WaitSchema } from './waits.js';

// Keep compilation explicit and library-owned. Importing `zod/compile` would
// change schema construction globally in every application that loads Workflow.
const hotPathSchemas = {
  AnalyticsAttributeKeySchema,
  AnalyticsEventSchema,
  AnalyticsHookSchema,
  AnalyticsRunSchema,
  AnalyticsStepSchema,
  AnalyticsWaitSchema,
  AttributeChangesSchema,
  BulkCancelWorkflowRunResultSchema,
  BulkCancelWorkflowRunsRequestSchema,
  BulkCancelWorkflowRunsResultSchema,
  CreateEventSchema,
  EventSchema,
  HealthCheckPayloadSchema,
  HookSchema,
  QueuePayloadSchema,
  StepSchema,
  StructuredErrorSchema,
  WaitSchema,
  WorkflowInvokePayloadSchema,
  WorkflowRunSchema,
} satisfies Record<string, z.ZodType>;

describe('schema compilation', () => {
  it.each(Object.entries(hotPathSchemas))('precompiles $0', (_name, schema) => {
    const compilerState = schema._zod.bag as { validator?: unknown };
    expect(compilerState.validator).toBeTypeOf('function');
  });
});
