import { WORKFLOW_QUEUE_TRIGGER } from '@workflow/builders';
import { describe, expect, it } from 'vitest';

import { stripWorkflowQueueTriggersFromConfig } from './vc-config.js';

describe('stripWorkflowQueueTriggersFromConfig', () => {
  it('removes workflow queue triggers while preserving unrelated triggers', () => {
    const unrelatedTrigger = {
      type: 'queue/v2beta',
      topic: 'user-topic',
      consumer: 'default',
    };

    expect(
      stripWorkflowQueueTriggersFromConfig({
        runtime: 'nodejs',
        experimentalTriggers: [WORKFLOW_QUEUE_TRIGGER, unrelatedTrigger],
      })
    ).toEqual({
      runtime: 'nodejs',
      experimentalTriggers: [unrelatedTrigger],
    });
  });

  it('deletes experimentalTriggers when only workflow triggers remain', () => {
    expect(
      stripWorkflowQueueTriggersFromConfig({
        runtime: 'nodejs',
        experimentalTriggers: [WORKFLOW_QUEUE_TRIGGER],
      })
    ).toEqual({
      runtime: 'nodejs',
    });
  });

  it('leaves configs without workflow triggers unchanged', () => {
    const config = {
      runtime: 'nodejs',
      experimentalTriggers: [
        {
          type: 'queue/v2beta',
          topic: 'user-topic',
          consumer: 'default',
        },
      ],
    };

    expect(stripWorkflowQueueTriggersFromConfig(config)).toBe(config);
  });
});
