'use strict';
/**
 * Utilities to convert @workflow/world schemas to DynamoDB table definitions
 *
 * This ensures we maintain a single source of truth for our data schema
 * and automatically stay in sync with the core workflow package.
 */
var __createBinding =
  (this && this.__createBinding) ||
  (Object.create
    ? function (o, m, k, k2) {
        if (k2 === undefined) k2 = k;
        var desc = Object.getOwnPropertyDescriptor(m, k);
        if (
          !desc ||
          ('get' in desc ? !m.__esModule : desc.writable || desc.configurable)
        ) {
          desc = {
            enumerable: true,
            get: function () {
              return m[k];
            },
          };
        }
        Object.defineProperty(o, k2, desc);
      }
    : function (o, m, k, k2) {
        if (k2 === undefined) k2 = k;
        o[k2] = m[k];
      });
var __setModuleDefault =
  (this && this.__setModuleDefault) ||
  (Object.create
    ? function (o, v) {
        Object.defineProperty(o, 'default', { enumerable: true, value: v });
      }
    : function (o, v) {
        o['default'] = v;
      });
var __importStar =
  (this && this.__importStar) ||
  function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null)
      for (var k in mod)
        if (k !== 'default' && Object.prototype.hasOwnProperty.call(mod, k))
          __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
  };
Object.defineProperty(exports, '__esModule', { value: true });
exports.getSchemaDocumentation =
  exports.getRequiredAttributes =
  exports.validateAgainstSchema =
  exports.getDynamoDBAttributeType =
  exports.getStepStatuses =
  exports.getWorkflowRunStatuses =
  exports.TableSchemas =
    void 0;
const world_1 = require('@workflow/world');
const dynamodb = __importStar(require('aws-cdk-lib/aws-dynamodb'));
/**
 * Extract attribute names and types from Zod schema
 */
function getSchemaFields(schema) {
  // Handle ZodObject
  if (schema.shape) {
    const shape = schema.shape;
    const fields = {};
    for (const [key, value] of Object.entries(shape)) {
      const zodType = value._def.typeName;
      fields[key] = {
        type: zodType,
        required: !value.isOptional(),
      };
    }
    return fields;
  }
  // For other schema types (like ZodIntersection), extract what we can
  const fields = {};
  const def = schema._def;
  if (def && def.left && def.left.shape) {
    for (const [key, value] of Object.entries(def.left.shape)) {
      const zodType = value._def.typeName;
      fields[key] = {
        type: zodType,
        required: !value.isOptional(),
      };
    }
  }
  if (def && def.right && def.right.shape) {
    for (const [key, value] of Object.entries(def.right.shape)) {
      const zodType = value._def.typeName;
      fields[key] = {
        type: zodType,
        required: !value.isOptional(),
      };
    }
  }
  return fields;
}
/**
 * Table schema metadata derived from @workflow/world schemas
 */
exports.TableSchemas = {
  runs: {
    schema: world_1.WorkflowRunSchema,
    fields: getSchemaFields(world_1.WorkflowRunSchema),
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
    schema: world_1.StepSchema,
    fields: getSchemaFields(world_1.StepSchema),
    partitionKey: 'stepId',
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
    schema: world_1.EventSchema,
    fields: getSchemaFields(world_1.EventSchema),
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
    schema: world_1.HookSchema,
    fields: getSchemaFields(world_1.HookSchema),
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
};
/**
 * Get valid statuses for workflow runs from the Zod schema
 */
function getWorkflowRunStatuses() {
  return world_1.WorkflowRunStatusSchema.options;
}
exports.getWorkflowRunStatuses = getWorkflowRunStatuses;
/**
 * Get valid statuses for steps from the Zod schema
 */
function getStepStatuses() {
  return world_1.StepStatusSchema.options;
}
exports.getStepStatuses = getStepStatuses;
/**
 * Helper to create a DynamoDB table with proper attribute types
 * based on the field definitions from the schema
 */
function getDynamoDBAttributeType(_fieldType) {
  // DynamoDB only supports STRING, NUMBER, and BINARY for keys
  // For our schemas, everything is STRING (including dates stored as ISO strings)
  // The fieldType parameter is reserved for future use when we need type-specific mappings
  return dynamodb.AttributeType.STRING;
}
exports.getDynamoDBAttributeType = getDynamoDBAttributeType;
/**
 * Validate that a JavaScript object matches the schema
 */
function validateAgainstSchema(tableName, data) {
  const tableSchema = exports.TableSchemas[tableName];
  if (!('schema' in tableSchema) || !tableSchema.schema) {
    throw new Error(`No schema validation available for table: ${tableName}`);
  }
  return tableSchema.schema.parse(data);
}
exports.validateAgainstSchema = validateAgainstSchema;
/**
 * Get the required attributes for a table based on the schema
 */
function getRequiredAttributes(tableName) {
  const tableSchema = exports.TableSchemas[tableName];
  return Object.entries(tableSchema.fields)
    .filter(([_, field]) => field.required)
    .map(([key]) => key);
}
exports.getRequiredAttributes = getRequiredAttributes;
/**
 * Documentation generator: show schema info
 */
function getSchemaDocumentation() {
  return {
    runs: {
      description: 'Workflow execution metadata',
      schema: exports.TableSchemas.runs.fields,
      validStatuses: getWorkflowRunStatuses(),
    },
    steps: {
      description: 'Individual step executions',
      schema: exports.TableSchemas.steps.fields,
      validStatuses: getStepStatuses(),
    },
    events: {
      description: 'Workflow event audit log',
      schema: exports.TableSchemas.events.fields,
    },
    hooks: {
      description: 'Webhook configurations',
      schema: exports.TableSchemas.hooks.fields,
    },
    streams: {
      description: 'Stream chunk metadata',
      schema: exports.TableSchemas.streams.fields,
    },
  };
}
exports.getSchemaDocumentation = getSchemaDocumentation;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2NoZW1hLXV0aWxzLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsic2NoZW1hLXV0aWxzLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7R0FLRzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFFSCwyQ0FPeUI7QUFDekIsbUVBQXFEO0FBRXJEOztHQUVHO0FBQ0gsU0FBUyxlQUFlLENBQUMsTUFBVztJQUNsQyxtQkFBbUI7SUFDbkIsSUFBSSxNQUFNLENBQUMsS0FBSyxFQUFFLENBQUM7UUFDakIsTUFBTSxLQUFLLEdBQUcsTUFBTSxDQUFDLEtBQUssQ0FBQztRQUMzQixNQUFNLE1BQU0sR0FBd0QsRUFBRSxDQUFDO1FBRXZFLEtBQUssTUFBTSxDQUFDLEdBQUcsRUFBRSxLQUFLLENBQUMsSUFBSSxNQUFNLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxFQUFFLENBQUM7WUFDakQsTUFBTSxPQUFPLEdBQUksS0FBYSxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUM7WUFDN0MsTUFBTSxDQUFDLEdBQUcsQ0FBQyxHQUFHO2dCQUNaLElBQUksRUFBRSxPQUFPO2dCQUNiLFFBQVEsRUFBRSxDQUFFLEtBQWEsQ0FBQyxVQUFVLEVBQUU7YUFDdkMsQ0FBQztRQUNKLENBQUM7UUFFRCxPQUFPLE1BQU0sQ0FBQztJQUNoQixDQUFDO0lBRUQscUVBQXFFO0lBQ3JFLE1BQU0sTUFBTSxHQUF3RCxFQUFFLENBQUM7SUFDdkUsTUFBTSxHQUFHLEdBQUksTUFBYyxDQUFDLElBQUksQ0FBQztJQUVqQyxJQUFJLEdBQUcsSUFBSSxHQUFHLENBQUMsSUFBSSxJQUFJLEdBQUcsQ0FBQyxJQUFJLENBQUMsS0FBSyxFQUFFLENBQUM7UUFDdEMsS0FBSyxNQUFNLENBQUMsR0FBRyxFQUFFLEtBQUssQ0FBQyxJQUFJLE1BQU0sQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxLQUFZLENBQUMsRUFBRSxDQUFDO1lBQ2pFLE1BQU0sT0FBTyxHQUFJ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QUF1QjtZQUNwQyxNQUFNLEVBQUUsb0JBQVksQ0FBQyxPQUFPLENBQUMsTUFBTTtTQUNwQztLQUNGLENBQUM7QUFDSixDQUFDO0FBekJELHdEQXlCQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogVXRpbGl0aWVzIHRvIGNvbnZlcnQgQHdvcmtmbG93L3dvcmxkIHNjaGVtYXMgdG8gRHluYW1vREIgdGFibGUgZGVmaW5pdGlvbnNcbiAqXG4gKiBUaGlzIGVuc3VyZXMgd2UgbWFpbnRhaW4gYSBzaW5nbGUgc291cmNlIG9mIHRydXRoIGZvciBvdXIgZGF0YSBzY2hlbWFcbiAqIGFuZCBhdXRvbWF0aWNhbGx5IHN0YXkgaW4gc3luYyB3aXRoIHRoZSBjb3JlIHdvcmtmbG93IHBhY2thZ2UuXG4gKi9cblxuaW1wb3J0IHtcbiAgRXZlbnRTY2hlbWEsXG4gIEhvb2tTY2hlbWEsXG4gIFN0ZXBTY2hlbWEsXG4gIFN0ZXBTdGF0dXNTY2hlbWEsXG4gIFdvcmtmbG93UnVuU2NoZW1hLFxuICBXb3JrZmxvd1J1blN0YXR1c1NjaGVtYSxcbn0gZnJvbSBcIkB3b3JrZmxvdy93b3JsZFwiO1xuaW1wb3J0ICogYXMgZHluYW1vZGIgZnJvbSBcImF3cy1jZGstbGliL2F3cy1keW5hbW9kYlwiO1xuXG4vKipcbiAqIEV4dHJhY3QgYXR0cmlidXRlIG5hbWVzIGFuZCB0eXBlcyBmcm9tIFpvZCBzY2hlbWFcbiAqL1xuZnVuY3Rpb24gZ2V0U2NoZW1hRmllbGRzKHNjaGVtYTogYW55KSB7XG4gIC8vIEhhbmRsZSBab2RPYmplY3RcbiAgaWYgKHNjaGVtYS5zaGFwZSkge1xuICAgIGNvbnN0IHNoYXBlID0gc2NoZW1hLnNoYXBlO1xuICAgIGNvbnN0IGZpZWxkczogUmVjb3JkPHN0cmluZywgeyB0eXBlOiBzdHJpbmc7IHJlcXVpcmVkOiBib29sZWFuIH0+ID0ge307XG5cbiAgICBmb3IgKGNvbnN0IFtrZXksIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyhzaGFwZSkpIHtcbiAgICAgIGNvbnN0IHpvZFR5cGUgPSAodmFsdWUgYXMgYW55KS5fZGVmLnR5cGVOYW1lO1xuICAgICAgZmllbGRzW2tleV0gPSB7XG4gICAgICAgIHR5cGU6IHpvZFR5cGUsXG4gICAgICAgIHJlcXVpcmVkOiAhKHZhbHVlIGFzIGFueSkuaXNPcHRpb25hbCgpLFxuICAgICAgfTtcbiAgICB9XG5cbiAgICByZXR1cm4gZmllbGRzO1xuICB9XG5cbiAgLy8gRm9yIG90aGVyIHNjaGVtYSB0eXBlcyAobGlrZSBab2RJbnRlcnNlY3Rpb24pLCBleHRyYWN0IHdoYXQgd2UgY2FuXG4gIGNvbnN0IGZpZWxkczogUmVjb3JkPHN0cmluZywgeyB0eXBlOiBzdHJpbmc7IHJlcXVpcmVkOiBib29sZWFuIH0+ID0ge307XG4gIGNvbnN0IGRlZiA9IChzY2hlbWEgYXMgYW55KS5fZGVmO1xuXG4gIGlmIChkZWYgJiYgZGVmLmxlZnQgJiYgZGVmLmxlZnQuc2hhcGUpIHtcbiAgICBmb3IgKGNvbnN0IFtrZXksIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyhkZWYubGVmdC5zaGFwZSBhcyBhbnkpKSB7XG4gICAgICBjb25zdCB6b2RUeXBlID0gKHZhbHVlIGFzIGFueSkuX2RlZi50eXBlTmFtZTtcbiAgICAgIGZpZWxkc1trZXldID0ge1xuICAgICAgICB0eXBlOiB6b2RUeXBlLFxuICAgICAgICByZXF1aXJlZDogISh2YWx1ZSBhcyBhbnkpLmlzT3B0aW9uYWwoKSxcbiAgICAgIH07XG4gICAgfVxuICB9XG5cbiAgaWYgKGRlZiAmJiBkZWYucmlnaHQgJiYgZGVmLnJpZ2h0LnNoYXBlKSB7XG4gICAgZm9yIChjb25zdCBba2V5LCB2YWx1ZV0gb2YgT2JqZWN0LmVudHJpZXMoZGVmLnJpZ2h0LnNoYXBlIGFzIGFueSkpIHtcbiAgICAgIGNvbnN0IHpvZFR5cGUgPSAodmFsdWUgYXMgYW55KS5fZGVmLnR5cGVOYW1lO1xuICAgICAgZmllbGRzW2tleV0gPSB7XG4gICAgICAgIHR5cGU6IHpvZFR5cGUsXG4gICAgICAgIHJlcXVpcmVkOiAhKHZhbHVlIGFzIGFueSkuaXNPcHRpb25hbCgpLFxuICAgICAgfTtcbiAgICB9XG4gIH1cblxuICByZXR1cm4gZmllbGRzO1xufVxuXG4vKipcbiAqIFRhYmxlIHNjaGVtYSBtZXRhZGF0YSBkZXJpdmVkIGZyb20gQHdvcmtmbG93L3dvcmxkIHNjaGVtYXNcbiAqL1xuZXhwb3J0IGNvbnN0IFRhYmxlU2NoZW1hczogUmVjb3JkPHN0cmluZywgYW55PiA9IHtcbiAgcnVuczoge1xuICAgIHNjaGVtYTogV29ya2Zsb3dSdW5TY2hlbWEsXG4gICAgZmllbGRzOiBnZXRTY2hlbWFGaWVsZHMoV29ya2Zsb3dSdW5TY2hlbWEpLFxuICAgIHBhcnRpdGlvbktleTogXCJydW5JZFwiLFxuICAgIGluZGV4ZXM6IFtcbiAgICAgIHtcbiAgICAgICAgbmFtZTogXCJ3b3JrZmxvd05hbWUtY3JlYXRlZEF0LWluZGV4XCIsXG4gICAgICAgIHBhcnRpdGlvbktleTogXCJ3b3JrZmxvd05hbWVcIixcbiAgICAgICAgc29ydEtleTogXCJjcmVhdGVkQXRcIixcbiAgICAgIH0sXG4gICAgICB7XG4gICAgICAgIG5hbWU6IFwic3RhdHVzLWNyZWF0ZWRBdC1pbmRleFwiLFxuICAgICAgICBwYXJ0aXRpb25LZXk6IFwic3RhdHVzXCIsXG4gICAgICAgIHNvcnRLZXk6IFwiY3JlYXRlZEF0XCIsXG4gICAgICB9LFxuICAgICAge1xuICAgICAgICBuYW1lOiBcImRlcGxveW1lbnRJZC1jcmVhdGVkQXQtaW5kZXhcIixcbiAgICAgICAgcGFydGl0aW9uS2V5OiBcImRlcGxveW1lbnRJZFwiLFxuICAgICAgICBzb3J0S2V5OiBcImNyZWF0ZWRBdFwiLFxuICAgICAgfSxcbiAgICBdLFxuICB9LFxuICBzdGVwczoge1xuICAgIHNjaGVtYTogU3RlcFNjaGVtYSxcbiAgICBmaWVsZHM6IGdldFNjaGVtYUZpZWxkcyhTdGVwU2NoZW1hKSxcbiAgICBwYXJ0aXRpb25LZXk6IFwic3RlcElkXCIsXG4gICAgaW5kZXhlczogW1xuICAgICAge1xuICAgICAgICBuYW1lOiBcInJ1bklkLWNyZWF0ZWRBdC1pbmRleFwiLFxuICAgICAgICBwYXJ0aXRpb25LZXk6IFwicnVuSWRcIixcbiAgICAgICAgc29ydEtleTogXCJjcmVhdGVkQXRcIixcbiAgICAgIH0sXG4gICAgICB7XG4gICAgICAgIG5hbWU6IFwic3RhdHVzLWNyZWF0ZWRBdC1pbmRleFwiLFxuICAgICAgICBwYXJ0aXRpb25LZXk6IFwic3RhdHVzXCIsXG4gICAgICAgIHNvcnRLZXk6IFwiY3JlYXRlZEF0XCIsXG4gICAgICB9LFxuICAgIF0sXG4gIH0sXG4gIGV2ZW50czoge1xuICAgIHNjaGVtYTogRXZlbnRTY2hlbWEsXG4gICAgZmllbGRzOiBnZXRTY2hlbWFGaWVsZHMoRXZlbnRTY2hlbWEpLFxuICAgIHBhcnRpdGlvbktleTogXCJldmVudElkXCIsXG4gICAgaW5kZXhlczogW1xuICAgICAge1xuICAgICAgICBuYW1lOiBcInJ1bklkLWNyZWF0ZWRBdC1pbmRleFwiLFxuICAgICAgICBwYXJ0aXRpb25LZXk6IFwicnVuSWRcIixcbiAgICAgICAgc29ydEtleTogXCJjcmVhdGVkQXRcIixcbiAgICAgIH0sXG4gICAgICB7XG4gICAgICAgIG5hbWU6IFwiY29ycmVsYXRpb25JZC1jcmVhdGVkQXQtaW5kZXhcIixcbiAgICAgICAgcGFydGl0aW9uS2V5OiBcImNvcnJlbGF0aW9uSWRcIixcbiAgICAgICAgc29ydEtleTogXCJjcmVhdGVkQXRcIixcbiAgICAgIH0sXG4gICAgXSxcbiAgfSxcbiAgaG9va3M6IHtcbiAgICBzY2hlbWE6IEhvb2tTY2hlbWEsXG4gICAgZmllbGRzOiBnZXRTY2hlbWFGaWVsZHMoSG9va1NjaGVtYSksXG4gICAgcGFydGl0aW9uS2V5OiBcImhvb2tJZFwiLFxuICAgIGluZGV4ZXM6IFtcbiAgICAgIHtcbiAgICAgICAgbmFtZTogXCJ0b2tlbi1pbmRleFwiLFxuICAgICAgICBwYXJ0aXRpb25LZXk6IFwidG9rZW5cIixcbiAgICAgICAgc29ydEtleTogdW5kZWZpbmVkLFxuICAgICAgfSxcbiAgICAgIHtcbiAgICAgICAgbmFtZTogXCJydW5JZC1jcmVhdGVkQXQtaW5kZXhcIixcbiAgICAgICAgcGFydGl0aW9uS2V5OiBcInJ1bklkXCIsXG4gICAgICAgIHNvcnRLZXk6IFwiY3JlYXRlZEF0XCIsXG4gICAgICB9LFxuICAgIF0sXG4gIH0sXG4gIHN0cmVhbXM6IHtcbiAgICAvLyBOb3RlOiBTdHJlYW1zIGRvbid0IGhhdmUgYSBab2Qgc2NoZW1hIGluIEB3b3JrZmxvdy93b3JsZCB5ZXRcbiAgICAvLyBUaGlzIGlzIHRoZSBtZXRhZGF0YSB0YWJsZSBmb3Igc3RyZWFtIGNodW5rc1xuICAgIHBhcnRpdGlvbktleTogXCJzdHJlYW1JZFwiLFxuICAgIHNvcnRLZXk6IFwiY2h1bmtJZFwiLFxuICAgIGZpZWxkczoge1xuICAgICAgc3RyZWFtSWQ6IHsgdHlwZTogXCJzdHJpbmdcIiwgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgIGNodW5rSWQ6IHsgdHlwZTogXCJzdHJpbmdcIiwgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgIHMzS2V5OiB7IHR5cGU6IFwic3RyaW5nXCIsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICBlb2Y6IHsgdHlwZTogXCJib29sZWFuXCIsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICBjcmVhdGVkQXQ6IHsgdHlwZTogXCJkYXRlXCIsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgfSxcbiAgICBpbmRleGVzOiBbXSxcbiAgfSxcbn0gYXMgY29uc3Q7XG5cbi8qKlxuICogR2V0IHZhbGlkIHN0YXR1c2VzIGZvciB3b3JrZmxvdyBydW5zIGZyb20gdGhlIFpvZCBzY2hlbWFcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGdldFdvcmtmbG93UnVuU3RhdHVzZXMoKTogc3RyaW5nW10ge1xuICByZXR1cm4gV29ya2Zsb3dSdW5TdGF0dXNTY2hlbWEub3B0aW9ucztcbn1cblxuLyoqXG4gKiBHZXQgdmFsaWQgc3RhdHVzZXMgZm9yIHN0ZXBzIGZyb20gdGhlIFpvZCBzY2hlbWFcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGdldFN0ZXBTdGF0dXNlcygpOiBzdHJpbmdbXSB7XG4gIHJldHVybiBTdGVwU3RhdHVzU2NoZW1hLm9wdGlvbnM7XG59XG5cbi8qKlxuICogSGVscGVyIHRvIGNyZWF0ZSBhIER5bmFtb0RCIHRhYmxlIHdpdGggcHJvcGVyIGF0dHJpYnV0ZSB0eXBlc1xuICogYmFzZWQgb24gdGhlIGZpZWxkIGRlZmluaXRpb25zIGZyb20gdGhlIHNjaGVtYVxuICovXG5leHBvcnQgZnVuY3Rpb24gZ2V0RHluYW1vREJBdHRyaWJ1dGVUeXBlKFxuICBfZmllbGRUeXBlOiBzdHJpbmdcbik6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUge1xuICAvLyBEeW5hbW9EQiBvbmx5IHN1cHBvcnRzIFNUUklORywgTlVNQkVSLCBhbmQgQklOQVJZIGZvciBrZXlzXG4gIC8vIEZvciBvdXIgc2NoZW1hcywgZXZlcnl0aGluZyBpcyBTVFJJTkcgKGluY2x1ZGluZyBkYXRlcyBzdG9yZWQgYXMgSVNPIHN0cmluZ3MpXG4gIC8vIFRoZSBmaWVsZFR5cGUgcGFyYW1ldGVyIGlzIHJlc2VydmVkIGZvciBmdXR1cmUgdXNlIHdoZW4gd2UgbmVlZCB0eXBlLXNwZWNpZmljIG1hcHBpbmdzXG4gIHJldHVybiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORztcbn1cblxuLyoqXG4gKiBWYWxpZGF0ZSB0aGF0IGEgSmF2YVNjcmlwdCBvYmplY3QgbWF0Y2hlcyB0aGUgc2NoZW1hXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB2YWxpZGF0ZUFnYWluc3RTY2hlbWE8VD4oXG4gIHRhYmxlTmFtZToga2V5b2YgdHlwZW9mIFRhYmxlU2NoZW1hcyxcbiAgZGF0YTogdW5rbm93blxuKTogVCB7XG4gIGNvbnN0IHRhYmxlU2NoZW1hID0gVGFibGVTY2hlbWFzW3RhYmxlTmFtZV07XG4gIGlmICghKFwic2NoZW1hXCIgaW4gdGFibGVTY2hlbWEpIHx8ICF0YWJsZVNjaGVtYS5zY2hlbWEpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYE5vIHNjaGVtYSB2YWxpZGF0aW9uIGF2YWlsYWJsZSBmb3IgdGFibGU6ICR7dGFibGVOYW1lfWApO1xuICB9XG4gIHJldHVybiB0YWJsZVNjaGVtYS5zY2hlbWEucGFyc2UoZGF0YSkgYXMgVDtcbn1cblxuLyoqXG4gKiBHZXQgdGhlIHJlcXVpcmVkIGF0dHJpYnV0ZXMgZm9yIGEgdGFibGUgYmFzZWQgb24gdGhlIHNjaGVtYVxuICovXG5leHBvcnQgZnVuY3Rpb24gZ2V0UmVxdWlyZWRBdHRyaWJ1dGVzKFxuICB0YWJsZU5hbWU6IGtleW9mIHR5cGVvZiBUYWJsZVNjaGVtYXNcbik6IHN0cmluZ1tdIHtcbiAgY29uc3QgdGFibGVTY2hlbWEgPSBUYWJsZVNjaGVtYXNbdGFibGVOYW1lXTtcbiAgcmV0dXJuIE9iamVjdC5lbnRyaWVzKHRhYmxlU2NoZW1hLmZpZWxkcylcbiAgICAuZmlsdGVyKChbXywgZmllbGRdOiBbc3RyaW5nLCBhbnldKSA9PiBmaWVsZC5yZXF1aXJlZClcbiAgICAubWFwKChba2V5XSkgPT4ga2V5KTtcbn1cblxuLyoqXG4gKiBEb2N1bWVudGF0aW9uIGdlbmVyYXRvcjogc2hvdyBzY2hlbWEgaW5mb1xuICovXG5leHBvcnQgZnVuY3Rpb24gZ2V0U2NoZW1hRG9jdW1lbnRhdGlvbigpIHtcbiAgcmV0dXJuIHtcbiAgICBydW5zOiB7XG4gICAgICBkZXNjcmlwdGlvbjogXCJXb3JrZmxvdyBleGVjdXRpb24gbWV0YWRhdGFcIixcbiAgICAgIHNjaGVtYTogVGFibGVTY2hlbWFzLnJ1bnMuZmllbGRzLFxuICAgICAgdmFsaWRTdGF0dXNlczogZ2V0V29ya2Zsb3dSdW5TdGF0dXNlcygpLFxuICAgIH0sXG4gICAgc3RlcHM6IHtcbiAgICAgIGRlc2NyaXB0aW9uOiBcIkluZGl2aWR1YWwgc3RlcCBleGVjdXRpb25zXCIsXG4gICAgICBzY2hlbWE6IFRhYmxlU2NoZW1hcy5zdGVwcy5maWVsZHMsXG4gICAgICB2YWxpZFN0YXR1c2VzOiBnZXRTdGVwU3RhdHVzZXMoKSxcbiAgICB9LFxuICAgIGV2ZW50czoge1xuICAgICAgZGVzY3JpcHRpb246IFwiV29ya2Zsb3cgZXZlbnQgYXVkaXQgbG9nXCIsXG4gICAgICBzY2hlbWE6IFRhYmxlU2NoZW1hcy5ldmVudHMuZmllbGRzLFxuICAgIH0sXG4gICAgaG9va3M6IHtcbiAgICAgIGRlc2NyaXB0aW9uOiBcIldlYmhvb2sgY29uZmlndXJhdGlvbnNcIixcbiAgICAgIHNjaGVtYTogVGFibGVTY2hlbWFzLmhvb2tzLmZpZWxkcyxcbiAgICB9LFxuICAgIHN0cmVhbXM6IHtcbiAgICAgIGRlc2NyaXB0aW9uOiBcIlN0cmVhbSBjaHVuayBtZXRhZGF0YVwiLFxuICAgICAgc2NoZW1hOiBUYWJsZVNjaGVtYXMuc3RyZWFtcy5maWVsZHMsXG4gICAgfSxcbiAgfTtcbn1cbiJdfQ==
