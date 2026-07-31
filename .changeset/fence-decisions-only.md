---
'@workflow/world': minor
'@workflow/world-local': patch
'@workflow/world-postgres': patch
---

Fence only decision writes: `isDecisionEvent` classifies event requests as decisions (child-entity creations, terminal transitions, `attr_set`) vs facts (completions, receipts, non-lazy claims), and the `stateEventCount` fence in world-local and world-postgres now applies to decisions only — a stale fact is byte-identical to a fresh one and takes its meaning from its commit-assigned log position, so fencing it only converts steady traffic into replay-restart churn.
