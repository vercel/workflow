---
'@workflow/next': patch
---

Fix dev HMR dropping edits to already-tracked files that land while a full rediscovery rebuild is in flight; the post-rebuild baseline refresh absorbed such edits so their watcher events classified as no-ops and the change never reached the manifest. Files first discovered by the in-flight rebuild narrow the same race but a create-then-edit within one rebuild window can still be absorbed.
