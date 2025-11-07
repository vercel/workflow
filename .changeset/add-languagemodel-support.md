---
"@workflow/ai": patch
"@workflow/core": patch
---

Add LanguageModelV2 support to DurableAgent

The DurableAgent class now supports custom model providers through the LanguageModel type (string | LanguageModelV2), matching the interface of AI SDK v6's tool loop agents. This enables users to pass custom provider instances while maintaining backward compatibility with string model IDs.

Changes:
- Updated DurableAgentOptions.model to accept LanguageModel type
- Added serialization/deserialization for LanguageModelV2 instances
- Models are serialized as { provider, modelId } and reconstructed using gateway()
