/**
 * Serialization symbols re-exported from a module that is not `@workflow/*`.
 *
 * AI SDK provider packages ship this shape: `@ai-sdk/provider-utils` defines
 * the symbols and the provider classes import them. See
 * serde-imported-key-models.ts for why the class lives in a separate file.
 */
export const WORKFLOW_SERIALIZE = Symbol.for('workflow-serialize');
export const WORKFLOW_DESERIALIZE = Symbol.for('workflow-deserialize');
