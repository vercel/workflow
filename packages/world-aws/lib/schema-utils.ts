/**
 * Utilities to convert @workflow/world schemas to DynamoDB table definitions
 *
 * This ensures we maintain a single source of truth for our data schema
 * and automatically stay in sync with the core workflow package.
 */

import {
  EventSchema,
  HookSchema,
  StepSchema,
  StepStatusSchema,
  WorkflowRunSchema,
  WorkflowRunStatusSchema,
} from '@workflow/world';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';

/**
 * Extract attribute names and types from Zod schema
 */
function getSchemaFields(schema: any) {
  // Handle ZodObject
  if (schema.shape) {
    const shape = schema.shape;
    const fields: Record<string, { type: string; required: boolean }> = {};

    for (const [key, value] of Object.entries(shape)) {
      const zodType = (value as any)._def.typeName;
      fields[key] = {
        type: zodType,
        required: !(value as any).isOptional(),
      };
    }

    return fields;
  }

  // For other schema types (like ZodIntersection), extract what we can
  const fields: Record<string, { type: string; required: boolean }> = {};
  const def = (schema as any)._def;

  if (def && def.left && def.left.shape) {
    for (const [key, value] of Object.entries(def.left.shape as any)) {
      const zodType = (value as any)._def.typeName;
      fields[key] = {
        type: zodType,
        required: !(value as any).isOptional(),
      };
    }
  }

  if (def && def.right && def.right.shape) {
    for (const [key, value] of Object.entries(def.right.shape as any)) {
      const zodType = (value as any)._def.typeName;
      fields[key] = {
        type: zodType,
        required: !(value as any).isOptional(),
      };
    }
  }

  return fields;
}

/**
 * Table schema metadata derived from @workflow/world schemas
 */
export const TableSchemas: Record<string, any> = {
  runs: {
    schema: WorkflowRunSchema,
    fields: getSchemaFields(WorkflowRunSchema),
    partitionKey: 'runId',
    indexes: [
      {
        name: 'workflowName-createdAt-index',
        partitionKey: 'workflowName',
        sortKey: 'createdAt',
      },
      {
        name: 'status-createdAt-index',
        partitionKey: 'status',
        sortKey: 'createdAt',
      },
      {
        name: 'deploymentId-createdAt-index',
        partitionKey: 'deploymentId',
        sortKey: 'createdAt',
      },
    ],
  },
  steps: {
    schema: StepSchema,
    fields: getSchemaFields(StepSchema),
    partitionKey: 'stepId',
    sortKey: 'runId', // Add runId as sort key for composite primary key
    indexes: [
      {
        name: 'runId-createdAt-index',
        partitionKey: 'runId',
        sortKey: 'createdAt',
      },
      {
        name: 'status-createdAt-index',
        partitionKey: 'status',
        sortKey: 'createdAt',
      },
    ],
  },
  events: {
    schema: EventSchema,
    fields: getSchemaFields(EventSchema),
    partitionKey: 'eventId',
    indexes: [
      {
        name: 'runId-createdAt-index',
        partitionKey: 'runId',
        sortKey: 'createdAt',
      },
      {
        name: 'correlationId-createdAt-index',
        partitionKey: 'correlationId',
        sortKey: 'createdAt',
      },
    ],
  },
  hooks: {
    schema: HookSchema,
    fields: getSchemaFields(HookSchema),
    partitionKey: 'hookId',
    indexes: [
      {
        name: 'token-index',
        partitionKey: 'token',
        sortKey: undefined,
      },
      {
        name: 'runId-createdAt-index',
        partitionKey: 'runId',
        sortKey: 'createdAt',
      },
    ],
  },
  streams: {
    // Note: Streams don't have a Zod schema in @workflow/world yet
    // This is the metadata table for stream chunks
    partitionKey: 'streamId',
    sortKey: 'chunkId',
    fields: {
      streamId: { type: 'string', required: true },
      chunkId: { type: 'string', required: true },
      s3Key: { type: 'string', required: true },
      eof: { type: 'boolean', required: true },
      createdAt: { type: 'date', required: true },
    },
    indexes: [],
  },
} as const;

/**
 * Get valid statuses for workflow runs from the Zod schema
 */
export function getWorkflowRunStatuses(): string[] {
  return Object.values(WorkflowRunStatusSchema.enum);
}

/**
 * Get valid statuses for steps from the Zod schema
 */
export function getStepStatuses(): string[] {
  return Object.values(StepStatusSchema.enum);
}

/**
 * Helper to create a DynamoDB table with proper attribute types
 * based on the field definitions from the schema
 */
export function getDynamoDBAttributeType(
  _fieldType: string
): dynamodb.AttributeType {
  // DynamoDB only supports STRING, NUMBER, and BINARY for keys
  // For our schemas, everything is STRING (including dates stored as ISO strings)
  // The fieldType parameter is reserved for future use when we need type-specific mappings
  return dynamodb.AttributeType.STRING;
}

/**
 * Validate that a JavaScript object matches the schema
 */
export function validateAgainstSchema<T>(
  tableName: keyof typeof TableSchemas,
  data: unknown
): T {
  const tableSchema = TableSchemas[tableName];
  if (!('schema' in tableSchema) || !tableSchema.schema) {
    throw new Error(`No schema validation available for table: ${tableName}`);
  }
  return tableSchema.schema.parse(data) as T;
}

/**
 * Get the required attributes for a table based on the schema
 */
export function getRequiredAttributes(
  tableName: keyof typeof TableSchemas
): string[] {
  const tableSchema = TableSchemas[tableName];
  return Object.entries(tableSchema.fields)
    .filter(([_, field]: [string, any]) => field.required)
    .map(([key]) => key);
}

/**
 * Documentation generator: show schema info
 */
export function getSchemaDocumentation() {
  return {
    runs: {
      description: 'Workflow execution metadata',
      schema: TableSchemas.runs.fields,
      validStatuses: getWorkflowRunStatuses(),
    },
    steps: {
      description: 'Individual step executions',
      schema: TableSchemas.steps.fields,
      validStatuses: getStepStatuses(),
    },
    events: {
      description: 'Workflow event audit log',
      schema: TableSchemas.events.fields,
    },
    hooks: {
      description: 'Webhook configurations',
      schema: TableSchemas.hooks.fields,
    },
    streams: {
      description: 'Stream chunk metadata',
      schema: TableSchemas.streams.fields,
    },
  };
}
