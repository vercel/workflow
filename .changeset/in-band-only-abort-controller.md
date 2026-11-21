---
'@workflow/core': patch
---

Add `new AbortController({ inBandOnly: true })` in workflow code. Only workflow code can abort such a controller (passing the controller to a step throws, but passing its signal works), so on node:vm its hook no longer stops spec 9 run-ahead (proof of concept).
