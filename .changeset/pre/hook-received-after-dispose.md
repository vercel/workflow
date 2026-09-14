---
'@workflow/world-local': patch
---

Fix a `resumeHook` racing `hook.dispose()` being recorded after the disposal, which corrupted the receiving run's replay
