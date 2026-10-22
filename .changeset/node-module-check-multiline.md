---
'@workflow/builders': patch
---

Point the Node.js module error at the user's code when the offending import spans multiple lines. Multi-line imports are now reported by the Node.js module check, like single-line imports, instead of by the flow bundle safety check, so they no longer get its `typeof require` exemption or the `WORKFLOW_ALLOW_UNSAFE_FLOW_BUNDLE` escape hatch.
