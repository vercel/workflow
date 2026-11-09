---
"@workflow/core": patch
---

Spec 9: keep the run-ahead hazard check's cost flat as a delivery runs more inline steps. It copied every step the delivery had run into new sets for each live-feed event and reported event, across one context per boundary it had ever run ahead of, so a long sequential run's step-to-step overhead grew with its length (about 60 ms per step at 1,000 steps on world-vercel). Contexts now leave once their speculative writes settle, and the check answers membership without copying. The `workflow.execute` span records the most contexts held at once as `workflow.run_ahead.contexts_max`.
