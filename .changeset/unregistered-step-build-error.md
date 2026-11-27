---
"@workflow/builders": patch
---

Fail the build when workflow code can call a step that the steps bundle does not register. Every call to such a step used to fail at runtime with `Step "..." is not registered in the current deployment`; the build now lists up to 10 of them with their files and IDs. A step that workflow code only reaches through a package discovery does not follow, with node_modules discovery off or a package that does not depend on `workflow`, is reported as a warning instead. Set `WORKFLOW_ALLOW_UNREGISTERED_STEPS=1` to downgrade the failure to a warning.
