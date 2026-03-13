import { describe, expect, it } from 'vitest';
import { getTableDefinitions } from './dynamo.js';
import { tableNames } from './config.js';

describe('DynamoDB table definitions', () => {
  it('generates correct table names with prefix', () => {
    const names = tableNames('myapp');
    expect(names.runs).toBe('myapp_runs');
    expect(names.events).toBe('myapp_events');
    expect(names.steps).toBe('myapp_steps');
    expect(names.hooks).toBe('myapp_hooks');
    expect(names.waits).toBe('myapp_waits');
    expect(names.streams).toBe('myapp_streams');
  });

  it('generates table definitions for all tables', () => {
    const defs = getTableDefinitions('workflow');
    expect(defs).toHaveLength(6);

    const tableNamesList = defs.map((d) => d.TableName);
    expect(tableNamesList).toContain('workflow_runs');
    expect(tableNamesList).toContain('workflow_events');
    expect(tableNamesList).toContain('workflow_steps');
    expect(tableNamesList).toContain('workflow_hooks');
    expect(tableNamesList).toContain('workflow_waits');
    expect(tableNamesList).toContain('workflow_streams');
  });

  it('uses PAY_PER_REQUEST billing for all tables', () => {
    const defs = getTableDefinitions('workflow');
    for (const def of defs) {
      expect(def.BillingMode).toBe('PAY_PER_REQUEST');
    }
  });

  it('creates runs table with correct GSIs', () => {
    const defs = getTableDefinitions('workflow');
    const runsDef = defs.find((d) => d.TableName === 'workflow_runs')!;

    expect(runsDef.KeySchema).toEqual([
      { AttributeName: 'runId', KeyType: 'HASH' },
    ]);

    const gsiNames = runsDef.GlobalSecondaryIndexes?.map((g) => g.IndexName);
    expect(gsiNames).toContain('gsi_workflowName');
    expect(gsiNames).toContain('gsi_status');
  });

  it('creates events table with composite key', () => {
    const defs = getTableDefinitions('workflow');
    const eventsDef = defs.find((d) => d.TableName === 'workflow_events')!;

    expect(eventsDef.KeySchema).toEqual([
      { AttributeName: 'runId', KeyType: 'HASH' },
      { AttributeName: 'eventId', KeyType: 'RANGE' },
    ]);

    const gsiNames = eventsDef.GlobalSecondaryIndexes?.map((g) => g.IndexName);
    expect(gsiNames).toContain('gsi_correlationId');
  });

  it('creates streams table with composite key and runId GSI', () => {
    const defs = getTableDefinitions('workflow');
    const streamsDef = defs.find((d) => d.TableName === 'workflow_streams')!;

    expect(streamsDef.KeySchema).toEqual([
      { AttributeName: 'streamId', KeyType: 'HASH' },
      { AttributeName: 'chunkId', KeyType: 'RANGE' },
    ]);

    const gsiNames = streamsDef.GlobalSecondaryIndexes?.map((g) => g.IndexName);
    expect(gsiNames).toContain('gsi_runId');
  });
});
