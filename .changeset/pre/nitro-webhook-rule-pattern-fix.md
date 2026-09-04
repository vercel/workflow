---
"@workflow/nitro": patch
---

Match the webhook `functionRules` key (`:token`) to the handler route on Nitro v3 Vercel deploys so the runtime override is applied to the real `webhook/[token].func` instead of generating a duplicate `webhook/[...].func`. Also propagate `workflow.runtime` to the public manifest route for consistency.
