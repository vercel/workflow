export const DEFAULT_AI_MODEL = 'spacexai/grok-4.6';

export const AI_MODELS = [
  { id: DEFAULT_AI_MODEL, name: 'Grok 4.6' },
  { id: 'anthropic/claude-haiku-4.5', name: 'Claude Haiku 4.5' },
  { id: 'anthropic/claude-sonnet-5', name: 'Claude Sonnet 5' },
  { id: 'anthropic/claude-opus-5', name: 'Claude Opus 5' },
  { id: 'openai/gpt-5.2', name: 'GPT-5.2' },
  { id: 'openai/gpt-5.5', name: 'GPT-5.5' },
] as const;
