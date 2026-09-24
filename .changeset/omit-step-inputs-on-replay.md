---
'@workflow/world': patch
'@workflow/world-vercel': patch
'@workflow/core': patch
---

Replay no longer downloads recorded step inputs. The runtime asks the World to leave `input` out of the `step_created` and `step_started` events it returns for replay (the event list, the `run_started` and hook preloads, and inline deltas), because replay recomputes step arguments by re-running workflow code and steps read their input from the step entity. For workflows that pass growing state into their steps, this removes the part of the replay transfer that grows quadratically. Worlds that don't support it keep returning the inputs.
