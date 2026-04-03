---
description: Run the 7_full demo workflow
allowed-tools: Bash(curl:*), Bash(npx workflow:*), Bash(pnpm dev), Bash(docker *), Bash(open *)
---

Run the demo workflow with OpenTelemetry tracing enabled.

## Steps

1. **Start Jaeger** for OTEL trace visualization (if not already running):
   ```bash
   docker run -d --name jaeger-otel \
     -p 16686:16686 \
     -p 4317:4317 \
     -p 4318:4318 \
     jaegertracing/jaeger:2.4.0 2>&1 || docker start jaeger-otel
   ```

2. **Open the Jaeger UI** in the browser:
   ```bash
   open http://localhost:16686
   ```

3. **Start the workbench** (default: nextjs-turbopack) with OTEL tracing enabled:
   ```bash
   cd workbench/nextjs-turbopack
   OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4318" \
   OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf" \
   pnpm dev
   ```

   Also start the workflow web UI in a separate terminal (from the same workbench directory):
   ```bash
   cd workbench/nextjs-turbopack
   npx workflow web
   ```

4. **Trigger the 7_full.ts workflow**:
   ```bash
   curl -X POST "http://localhost:3000/api/trigger?workflowFile=workflows/7_full.ts&workflowFn=handleUserSignup"
   ```

5. **View traces** in Jaeger UI at http://localhost:16686 - select service `example-nextjs-workflow`

## Tracing Details

The traces include:
- Step execution spans with `workflow.queue.overhead_ms`, `step.attempt`, `step.status`
- Workflow orchestration spans with `workflow.run.status`, `workflow.events.count`
- Queue message spans with messaging attributes

$ARGUMENTS can specify a different workbench (e.g., "example" or "nextjs-webpack").
