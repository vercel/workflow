import { c as defineEventHandler } from "../../_libs/h3.mjs";
import { s as start, R as Run } from "../../index.mjs";
import "../../_libs/rou3.mjs";
import "../../_libs/srvx.mjs";
import "node:http";
import "node:stream";
import "node:https";
import "node:http2";
import "../../_chunks/_libs/@vercel/functions.mjs";
import "../../_libs/ms.mjs";
import "../../_chunks/_libs/@mongodb-js/zstd.mjs";
import "util";
import "util/types";
import "../../_libs/ulid.mjs";
import "node:crypto";
import "node:module";
import "node:path";
import "node:child_process";
import "node:fs/promises";
import "node:util";
import "node:url";
import "node:timers/promises";
import "../../_chunks/_libs/@vercel/queue.mjs";
import "../../_libs/mixpart.mjs";
import "../../_chunks/_libs/@vercel/oidc.mjs";
import "path";
import "fs";
import "os";
import "../../_chunks/_libs/async-sema.mjs";
import "events";
import "../../_chunks/_libs/undici.mjs";
import "node:assert";
import "node:net";
import "node:buffer";
import "node:querystring";
import "node:events";
import "node:diagnostics_channel";
import "node:tls";
import "node:zlib";
import "node:perf_hooks";
import "node:util/types";
import "node:worker_threads";
import "node:async_hooks";
import "node:console";
import "node:dns";
import "string_decoder";
import "../../_libs/zod.mjs";
import "node:fs";
import "node:os";
import "../../_libs/cbor-x.mjs";
import "../../_libs/devalue.mjs";
import "../../_chunks/_libs/debug.mjs";
import "tty";
import "../../_libs/supports-color.mjs";
import "../../_libs/has-flag.mjs";
import "../../_chunks/_libs/@jridgewell/trace-mapping.mjs";
import "../../_chunks/_libs/@jridgewell/sourcemap-codec.mjs";
import "../../_chunks/_libs/@jridgewell/resolve-uri.mjs";
import "node:vm";
import "../../_libs/nanoid.mjs";
import "../../_libs/seedrandom.mjs";
import "../../_libs/ufo.mjs";
async function serialBashWorkflow() {
  throw new Error("You attempted to execute workflow serialBashWorkflow function directly. To start a workflow, use start(serialBashWorkflow) from workflow/api");
}
serialBashWorkflow.workflowId = "workflow//workflows/bash-workflow.ts//serialBashWorkflow";
const bash_post = defineEventHandler(async () => {
  const { runId } = await start(serialBashWorkflow, []);
  const run = new Run(runId);
  const result = await run.returnValue;
  return {
    message: "Bash workflow completed",
    result
  };
});
export {
  bash_post as default
};
