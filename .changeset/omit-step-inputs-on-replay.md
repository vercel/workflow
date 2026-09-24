---
'@workflow/world': patch
'@workflow/world-vercel': patch
'@workflow/core': patch
'@workflow/world-local': patch
'@workflow/world-postgres': patch
'@workflow/world-testing': patch
---

Added a `resolveData: 'skip-step-inputs'` option, which directs the World to leave out `input` from `step_created` and `step_started` events. Replay recomputes step arguments by re-running workflow code, and steps take their input from the `step_started` response or from memory, never from the replay log, so replay now reads the event log with this option and no longer downloads recorded step inputs. For workflows that pass growing state into their steps, this removes the part of the replay transfer that grows quadratically. A World that doesn't implement the option must treat it as `'all'`.
