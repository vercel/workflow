---
---

Internal: the event-log-race-repro CI job now renders an actionable summary (every gating regression listed in full with a dashboard link; harness noise grouped by error code with explanations), treats slow-but-completed runs as non-gating instead of `stuck`, records where a stuck run wedged, and retries transient `fetch failed` network errors so a single dropped connection never aborts tracking a run.
