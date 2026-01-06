---
"@workflow/world": patch
"@workflow/world-local": patch
"@workflow/world-vercel": patch
"@workflow/cli": patch
"@workflow/web": patch
"@workflow/web-shared": patch
---

Remove the unused paused/resumed run events and states

- Remove `run_paused` and `run_resumed` event types
- Remove `paused` status from `WorkflowRunStatus`
- Remove `PauseWorkflowRunParams` and `ResumeWorkflowRunParams` types
- Remove `pauseWorkflowRun` and `resumeWorkflowRun` functions from world-vercel
