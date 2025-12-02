# @workflow/world-browser

## 0.0.1

### Added

- Initial release with browser-based World implementation
- Turso WASM (SQLite) based storage for runs, steps, events, and hooks
- SQLite-backed queue with polling processor
- Proxy-based deterministic context (Math.random, Date.now, crypto.randomUUID)
- SharedWorker entry point for multi-tab support
- Workflow execution engine for browser
- Main thread BrowserWorkflowClient SDK
- React hooks (useWorkflowRun, useWorkflowProgress, useWorkflowRuns)
- Support for `browser` transform mode in SWC plugin
