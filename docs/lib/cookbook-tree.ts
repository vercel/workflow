export type Recipe = {
  slug: string;
  title: string;
  description: string;
  category: string;
};

export type RecipeCategory =
  | 'common-patterns'
  | 'agent-patterns'
  | 'integrations'
  | 'advanced';

export const categoryOrder: RecipeCategory[] = [
  'agent-patterns',
  'common-patterns',
  'integrations',
  'advanced',
];

export const categoryLabels: Record<RecipeCategory, string> = {
  'agent-patterns': 'Agent Patterns',
  'common-patterns': 'Common Patterns',
  integrations: 'Integrations',
  advanced: 'Advanced',
};

/** Map from slug → category folder for URL construction */
export const slugToCategory: Record<string, string> = {
  // Common Patterns
  'sequential-and-parallel': 'common-patterns',
  'workflow-composition': 'common-patterns',
  saga: 'common-patterns',
  batching: 'common-patterns',
  'rate-limiting': 'common-patterns',
  scheduling: 'common-patterns',
  timeouts: 'common-patterns',
  idempotency: 'common-patterns',
  webhooks: 'common-patterns',

  // Agent Patterns
  'durable-agent': 'agent-patterns',
  'human-in-the-loop': 'agent-patterns',
  'agent-cancellation': 'agent-patterns',

  // Integrations
  'ai-sdk': 'integrations',
  sandbox: 'integrations',
  'chat-sdk': 'integrations',

  // Advanced
  'child-workflows': 'advanced',
  'distributed-abort-controller': 'advanced',
  'serializable-steps': 'advanced',
  'publishing-libraries': 'advanced',
};

/** All recipe metadata, keyed by slug */
export const recipes: Record<string, Recipe> = {
  // Common Patterns
  'sequential-and-parallel': {
    slug: 'sequential-and-parallel',
    title: 'Sequential & Parallel Execution',
    description:
      'Compose steps with familiar async/await patterns — sequential await, Promise.all, and Promise.race against durable sleeps and webhooks.',
    category: 'common-patterns',
  },
  'workflow-composition': {
    slug: 'workflow-composition',
    title: 'Workflow Composition',
    description:
      'Call workflows from other workflows by direct await (flatten into the parent) or background spawn via start() (separate run).',
    category: 'common-patterns',
  },
  saga: {
    slug: 'saga',
    title: 'Transactions & Rollbacks (Saga)',
    description:
      'Coordinate multi-step transactions with automatic rollback when a step fails.',
    category: 'common-patterns',
  },
  batching: {
    slug: 'batching',
    title: 'Batching & Parallel Processing',
    description:
      'Process large collections in parallel batches with failure isolation between groups.',
    category: 'common-patterns',
  },
  'rate-limiting': {
    slug: 'rate-limiting',
    title: 'Rate Limiting & Retries',
    description:
      'Handle 429 responses and transient failures with RetryableError and exponential backoff.',
    category: 'common-patterns',
  },
  scheduling: {
    slug: 'scheduling',
    title: 'Sleep, Scheduling & Timed Workflows',
    description:
      'Schedule future actions with durable sleep and race sleeps against hooks to let external events cancel the workflow early.',
    category: 'common-patterns',
  },
  timeouts: {
    slug: 'timeouts',
    title: 'Timeouts',
    description:
      'Add deadlines to slow steps, hooks, and webhooks by racing them against a durable sleep.',
    category: 'common-patterns',
  },
  idempotency: {
    slug: 'idempotency',
    title: 'Idempotency',
    description:
      'Ensure external side effects happen exactly once, even when steps are retried or workflows are replayed.',
    category: 'common-patterns',
  },
  webhooks: {
    slug: 'webhooks',
    title: 'Webhooks & External Callbacks',
    description:
      'Receive HTTP callbacks from external services, process them durably, and respond inline.',
    category: 'common-patterns',
  },

  // Agent Patterns
  'durable-agent': {
    slug: 'durable-agent',
    title: 'Durable Agent',
    description:
      'Replace a stateless AI agent with a durable one that survives crashes, retries tool calls, and streams output.',
    category: 'agent-patterns',
  },
  'human-in-the-loop': {
    slug: 'human-in-the-loop',
    title: 'Human-in-the-Loop',
    description:
      'Pause an AI agent to wait for human approval, then resume based on the decision.',
    category: 'agent-patterns',
  },
  'agent-cancellation': {
    slug: 'agent-cancellation',
    title: 'Agent Cancellation',
    description:
      'Cancel a running agent from the outside — Hard Cancellation via getRun(runId).cancel() for forced termination, or Stop Signal via a hook for a graceful exit.',
    category: 'agent-patterns',
  },

  // Integrations
  'ai-sdk': {
    slug: 'ai-sdk',
    title: 'AI SDK',
    description:
      'Use AI SDK model providers, tool calling, and streaming inside durable workflows.',
    category: 'integrations',
  },
  sandbox: {
    slug: 'sandbox',
    title: 'Sandbox',
    description:
      'Orchestrate Vercel Sandbox lifecycle \u2014 creation, code execution, snapshotting \u2014 inside durable workflows.',
    category: 'integrations',
  },
  'chat-sdk': {
    slug: 'chat-sdk',
    title: 'Chat SDK',
    description:
      'Build durable chat sessions by combining workflow persistence with AI SDK chat primitives.',
    category: 'integrations',
  },

  // Advanced
  'child-workflows': {
    slug: 'child-workflows',
    title: 'Child Workflows',
    description:
      'Spawn and orchestrate child workflows from a parent, polling for completion and handling partial failures.',
    category: 'advanced',
  },
  'distributed-abort-controller': {
    slug: 'distributed-abort-controller',
    title: 'Distributed Abort Controller',
    description:
      'Build a cross-process abort controller using workflow streams and hooks to coordinate cancellation by semantic ID.',
    category: 'advanced',
  },
  'serializable-steps': {
    slug: 'serializable-steps',
    title: 'Serializable Steps',
    description:
      'Wrap non-serializable objects (like AI model providers) inside step functions so they can cross the workflow boundary.',
    category: 'advanced',
  },
  'publishing-libraries': {
    slug: 'publishing-libraries',
    title: 'Publishing Libraries',
    description:
      'Ship an npm package that exports reusable workflow functions with stable IDs and clean step I/O.',
    category: 'advanced',
  },
};

/** Build a cookbook recipe href */
export function getRecipeHref(lang: string, slug: string): string {
  return `/${lang}/cookbook/${slugToCategory[slug]}/${slug}`;
}

/** Get recipes for a category, in definition order */
export function getRecipesByCategory(category: RecipeCategory): Recipe[] {
  return Object.values(recipes).filter((r) => r.category === category);
}
