import { WORKFLOW_QUEUE_TRIGGER } from '@workflow/builders';
import fs from 'fs-extra';

const WORKFLOW_QUEUE_TOPICS = new Set([WORKFLOW_QUEUE_TRIGGER.topic]);

function isWorkflowQueueTrigger(trigger: unknown) {
  if (typeof trigger !== 'object' || trigger === null) {
    return false;
  }

  const topic = (trigger as { topic?: unknown }).topic;
  return typeof topic === 'string' && WORKFLOW_QUEUE_TOPICS.has(topic);
}

export function stripWorkflowQueueTriggersFromConfig<
  TConfig extends Record<string, unknown>,
>(existingConfig: TConfig): TConfig {
  const experimentalTriggers = existingConfig.experimentalTriggers;
  if (!Array.isArray(experimentalTriggers)) {
    return existingConfig;
  }

  const filteredTriggers = experimentalTriggers.filter(
    (trigger) => !isWorkflowQueueTrigger(trigger)
  );
  if (filteredTriggers.length === experimentalTriggers.length) {
    return existingConfig;
  }

  const nextConfig: Record<string, unknown> = { ...existingConfig };
  if (filteredTriggers.length > 0) {
    nextConfig.experimentalTriggers = filteredTriggers;
  } else {
    delete nextConfig.experimentalTriggers;
  }

  return nextConfig as TConfig;
}

export function stripWorkflowQueueTriggers(file: string) {
  if (!fs.existsSync(file)) {
    return;
  }

  const existingConfig = JSON.parse(fs.readFileSync(file, 'utf8'));
  const nextConfig = stripWorkflowQueueTriggersFromConfig(existingConfig);
  if (nextConfig === existingConfig) {
    return;
  }

  fs.writeFileSync(file, JSON.stringify(nextConfig));
}
