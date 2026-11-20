---
"@workflow/builders": patch
---

Stop failing the workflow build when a dependency imports a Node.js module that no workflow calls. The workflow bundle now replaces such a module with a stand-in that loads in the sandbox and throws a `NodeJsModuleInWorkflowError` only if a workflow calls into it, and the build prints a warning naming the module and its importer. Node.js modules imported from your own code still fail the build.
