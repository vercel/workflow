---
---

Add Platformatic to `worlds-manifest.json` as a community world, and add a generic `docker` service type to the community-world CI (both the E2E and benchmark reusable workflows) so worlds can declare arbitrary Docker containers in their manifest `services` array. Platformatic's E2E job is gated by the existing `if: false` on `e2e-community` until community worlds ship CBOR queue transport support.
