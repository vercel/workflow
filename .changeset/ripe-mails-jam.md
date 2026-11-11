---
"@workflow/core": patch
---

Drain spec-9 inline race losers before terminalizing zero-retention runs, on both the node:vm and QuickJS engines, so late outcomes cannot repopulate purged payloads.
