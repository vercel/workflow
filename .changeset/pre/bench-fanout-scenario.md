---
---

Add a `Promise.all(100 no-op steps)` scenario to the CI benchmark, reported as separate Fan-out TTFS (first step of the fan-out to complete) and Fan-out TTLS (last one) rows so a change that speeds up the first branch while stretching the tail stays visible.
