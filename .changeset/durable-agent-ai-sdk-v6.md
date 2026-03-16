---
"@workflow/ai": minor
---

**BREAKING CHANGE**: Migrate to AI SDK v6. Drop AI SDK v5 support.

- Migrate all types from V2 to V3 (`LanguageModelV2*` → `LanguageModelV3*`)
- Update peer dependency: `ai` `^5 || ^6` → `^6`, `@ai-sdk/provider` `^2 || ^3` → `^3`
- Simplify `CompatibleLanguageModel` from V2|V3 union to `LanguageModelV3`
- Remove `providerExecuted` guard on tool-result stream parts (V3: all tool-results are provider-executed)
- Add `instructions` constructor option (replaces deprecated `system`)
- Add `onStepFinish` and `onFinish` on constructor (merged with stream callbacks)
- Add `timeout` stream option
- Enrich `onFinish` event with `text`, `finishReason`, `totalUsage`
- Add `@workflow/ai/test` export with `mockTextModel` and `mockSequenceModel` for workflow e2e testing
- Update `OutputSpecification` to match AI SDK v6 Output interface
- Fix `WorkflowChatTransport` to forward `body` and `headers` from `ChatRequestOptions` to `prepareSendMessagesRequest` and the default request body
