---
"@workflow/core": patch
---

Let each branch of a `Promise.all` start its next step without waiting for its slowest sibling: a settled branch advances on its own once the steps beside it are still running after a short grace delay, in fan-outs of up to 8 pending steps (`WORKFLOW_EAGER_BRANCH_REPLAY=0` restores the old behavior).
