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
  'common-patterns',
  'agent-patterns',
  'integrations',
  'advanced',
];

export const categoryLabels: Record<RecipeCategory, string> = {
  'common-patterns': 'Common Patterns',
  'agent-patterns': 'Agent Patterns',
  integrations: 'Integrations',
  advanced: 'Advanced',
};

/** Map from slug → category folder for URL construction */
export const slugToCategory: Record<string, string> = {
  // Common Patterns
  saga: 'common-patterns',
  batching: 'common-patterns',
  'rate-limiting': 'common-patterns',
  'fan-out': 'common-patterns',
  scheduling: 'common-patterns',
  idempotency: 'common-patterns',
  webhooks: 'common-patterns',
  'content-router': 'common-patterns',
  'child-workflows': 'common-patterns',

  // Agent Patterns
  'durable-agent': 'agent-patterns',
  'tool-streaming': 'agent-patterns',
  'human-in-the-loop': 'agent-patterns',
  'tool-orchestration': 'agent-patterns',
  'stop-workflow': 'agent-patterns',

  // Integrations
  'ai-sdk': 'integrations',
  sandbox: 'integrations',
  'chat-sdk': 'integrations',

  // Advanced
  'serializable-steps': 'advanced',
  'durable-objects': 'advanced',
  'isomorphic-packages': 'advanced',
  'secure-credentials': 'advanced',
  'custom-serialization': 'advanced',
  'publishing-libraries': 'advanced',
};

/** All recipe metadata, keyed by slug */
export const recipes: Record<string, Recipe> = {
  // Common Patterns
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
  'fan-out': {
    slug: 'fan-out',
    title: 'Fan-Out & Parallel Delivery',
    description:
      'Send a message to multiple channels or recipients in parallel with independent failure handling.',
    category: 'common-patterns',
  },
  scheduling: {
    slug: 'scheduling',
    title: 'Sleep, Scheduling & Timed Workflows',
    description:
      'Use durable sleep to schedule actions minutes, hours, days, or weeks into the future.',
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
  'content-router': {
    slug: 'content-router',
    title: 'Conditional Routing',
    description:
      'Inspect a payload and route it to different step handlers based on its content.',
    category: 'common-patterns',
  },
  'child-workflows': {
    slug: 'child-workflows',
    title: 'Child Workflows',
    description:
      'Spawn and orchestrate child workflows from a parent, polling for completion and handling partial failures.',
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
  'tool-streaming': {
    slug: 'tool-streaming',
    title: 'Tool Streaming',
    description:
      'Stream real-time progress updates from tools to the UI while they execute.',
    category: 'agent-patterns',
  },
  'human-in-the-loop': {
    slug: 'human-in-the-loop',
    title: 'Human-in-the-Loop',
    description:
      'Pause an AI agent to wait for human approval, then resume based on the decision.',
    category: 'agent-patterns',
  },
  'tool-orchestration': {
    slug: 'tool-orchestration',
    title: 'Tool Orchestration',
    description:
      'Choose between step-level and workflow-level tools, or combine both for complex tool implementations.',
    category: 'agent-patterns',
  },
  'stop-workflow': {
    slug: 'stop-workflow',
    title: 'Stop Workflow',
    description:
      'Gracefully cancel a running agent workflow using a hook signal.',
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
  'serializable-steps': {
    slug: 'serializable-steps',
    title: 'Serializable Steps',
    description:
      'Wrap non-serializable objects (like AI model providers) inside step functions so they can cross the workflow boundary.',
    category: 'advanced',
  },
  'durable-objects': {
    slug: 'durable-objects',
    title: 'Durable Objects',
    description:
      'Model long-lived stateful entities as workflows that persist state across requests.',
    category: 'advanced',
  },
  'isomorphic-packages': {
    slug: 'isomorphic-packages',
    title: 'Isomorphic Packages',
    description:
      'Publish reusable workflow packages that work both inside and outside the workflow runtime.',
    category: 'advanced',
  },
  'secure-credentials': {
    slug: 'secure-credentials',
    title: 'Secure Credentials',
    description:
      'Encrypt secrets before passing them through workflows so they never appear in the event log.',
    category: 'advanced',
  },
  'custom-serialization': {
    slug: 'custom-serialization',
    title: 'Custom Serialization',
    description:
      'Make custom classes survive workflow serialization using the WORKFLOW_SERIALIZE/WORKFLOW_DESERIALIZE protocol.',
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
