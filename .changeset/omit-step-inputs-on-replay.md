---
'@workflow/world': patch
'@workflow/world-vercel': patch
'@workflow/core': patch
'@workflow/world-local': patch
'@workflow/world-postgres': patch
'@workflow/world-sim': patch
---

Replay no longer downloads recorded step inputs. The runtime reads the event log with `resolveData: 'skip-step-inputs'`, a new event-read resolution mode in which the World may leave `input` out of `step_created` and `step_started` events. It uses the mode for the event list, the `run_started` and hook preloads, and inline deltas. Replay recomputes step arguments by re-running workflow code, and steps read their input from the step entity. For workflows that pass growing state into their steps, this removes the part of the replay transfer that grows quadratically. Worlds that don't support the mode keep returning the inputs, and world-vercel falls back to full resolution against a server that predates it.
