---
---

Add Platformatic to `worlds-manifest.json` as a community world, and add a generic `docker` service type to the community-world CI so worlds can declare arbitrary Docker containers in their manifest `services` array. Platformatic's CI job is gated by the existing `if: false` on `e2e-community` until community worlds ship CBOR queue transport support.
