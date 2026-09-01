---
---

Remove the neighboring-region execution leniency from the multi-region e2e suite: the workflow and step must now execute strictly in the run's tagged region. Region mismatches fail with the workflow run ID and the offending invocation's Vercel proxy request ID (x-vercel-id) so CI reports carry everything needed to investigate routing bugs.
