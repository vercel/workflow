/**
 * Utilities to convert @workflow/world schemas to DynamoDB table definitions
 *
 * This ensures we maintain a single source of truth for our data schema
 * and automatically stay in sync with the core workflow package.
 */
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
/**
 * Table schema metadata derived from @workflow/world schemas
 */
export declare const TableSchemas: Record<string, any>;
/**
 * Get valid statuses for workflow runs from the Zod schema
 */
export declare function getWorkflowRunStatuses(): string[];
/**
 * Get valid statuses for steps from the Zod schema
 */
export declare function getStepStatuses(): string[];
/**
 * Helper to create a DynamoDB table with proper attribute types
 * based on the field definitions from the schema
 */
export declare function getDynamoDBAttributeType(
  _fieldType: string
): dynamodb.AttributeType;
/**
 * Validate that a JavaScript object matches the schema
 */
export declare function validateAgainstSchema<T>(
  tableName: keyof typeof TableSchemas,
  data: unknown
): T;
/**
 * Get the required attributes for a table based on the schema
 */
export declare function getRequiredAttributes(
  tableName: keyof typeof TableSchemas
): string[];
/**
 * Documentation generator: show schema info
 */
export declare function getSchemaDocumentation(): {
  runs: {
    description: string;
    schema: any;
    validStatuses: string[];
  };
  steps: {
    description: string;
    schema: any;
    validStatuses: string[];
  };
  events: {
    description: string;
    schema: any;
  };
  hooks: {
    description: string;
    schema: any;
  };
  streams: {
    description: string;
    schema: any;
  };
};
