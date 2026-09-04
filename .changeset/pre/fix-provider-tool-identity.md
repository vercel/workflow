---
'@workflow/ai': patch
---

fix(ai): preserve provider tool identity across step boundaries

Provider tools (e.g. `anthropic.tools.webSearch`) were being converted to plain function tools in `toolsToModelTools`, stripping `type: 'provider'`, `id`, and `args`. This caused providers like Anthropic Gateway to not recognize them as provider-executed tools.
