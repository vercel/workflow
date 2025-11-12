---
description: Run the 7_full demo workflow
allowed-tools: Bash(curl:*), Bash(npx workflow:*), Bash(pnpm dev)
---


Start the $ARUGMENTS workbench (default to the nextjs turboback workbench  available in the workbenches directory). Run it in dev mode, and also start the workflow web UI (run `npx workflow web` inside the appropriate workbench directory).

Then trigger the 7_full.ts workflow example. you can see how to trigger a specific example by looking at the trigger API route for the workbench - it is probably just a POST request using bash (maybe curl) to this endpoint: <http://localhost:3000/api/trigger\?workflowFile\=workflows/7_full.ts\&workflowFn\=handleUserSignup>>
