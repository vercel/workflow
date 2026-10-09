# @workflow/core

Core runtime package for [Workflow SDK](https://useworkflow.dev).

Hook registration acknowledgements and token conflicts participate in replay
delivery ordering alongside step results, hook payloads, and sleep completions.
Concurrent branches awaiting `hook.getConflict()` preserve their step correlation
IDs when replaying an extended event history.

Failed-run logs include underlying error causes and codes to help diagnose failures such as socket, DNS, and TLS errors. Unreadable causes are marked without preventing the run from being recorded as failed.
