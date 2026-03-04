# @workflow/vitest-workbench

This workbench demonstrates how to test workflows with Vitest using the `@workflow/vitest` plugin.

## How It Works

1. **Vitest Plugin**: The `workflow()` plugin from `@workflow/vitest` handles SWC transforms, bundle building, and in-process handler registration automatically.
2. **No Server Required**: Workflows execute entirely in-process using a [Local World](/docs/worlds/local) instance — no HTTP server needed.
3. **Tests**: Use `start(workflow, args)` and await `run.returnValue`, plus helpers like `waitForSleep()` and `waitForHook()`.

## Usage

```bash
pnpm test
```

## Project Structure

```
workbench/vitest/
├── workflows/
│   ├── simple.ts          # Basic workflow with arithmetic steps
│   ├── sleeping.ts        # Workflows with sleep() calls
│   ├── hooks.ts           # Workflow with createHook() for external data
│   └── webhook.ts         # Workflow with createWebhook() for HTTP payloads
├── test/
│   └── workflow.test.ts   # Integration tests for all workflow types
├── vitest.config.ts       # Vitest config with workflow() plugin
├── MOCKING.md             # Analysis of mocking limitations
└── package.json
```

## Test Coverage

- **Simple workflow**: Start and await return value
- **Sleep workflow**: `waitForSleep()` → `wakeUp()` to skip sleep
- **Multi-sleep workflow**: Targeted `wakeUp()` with correlation IDs
- **Hook workflow**: `waitForHook()` → `resumeHook()` with approval/rejection
- **Webhook workflow**: `waitForHook()` → `resumeWebhook()` with Request payload
