---
'@workflow/builders': patch
'@workflow/next': patch
---

Fail the build when the workflow bundle still contains `require()`. The workflow sandbox has no `require`, so an import esbuild left external (most often a Node.js builtin reached through a transitive dependency or a re-export) or an unresolved dynamic `require()` used to produce a bundle that threw `ReferenceError: require is not defined` on its first load. The build now reports the specifier, the module that imported it and the import chain back to user code. A `require()` inside a `try`/`catch` block, or behind a `typeof require` check, is left alone, since that is how packages probe for an optional dependency and the call either fails harmlessly or never runs. Set `WORKFLOW_ALLOW_UNSAFE_FLOW_BUNDLE=1` to downgrade the failure to a warning.
