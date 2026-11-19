// Serves `createBacklogEndpoints` from the built package, for the chart's
// kwok e2e test, and creates or finishes pinned runs on request:
//
//   WORKFLOW_POSTGRES_URL=... JOB_PREFIX=svc_ PORT=3600 node backlog-server.mjs
//
//   POST /runs/<deploymentId>   creates a pinned run, returns its id
//   POST /finish/<runId>        marks it completed
import { createServer } from 'node:http';
import pg from 'pg';
import { ulid } from 'ulid';
import { createWorld } from '../../dist/index.js';
import { createBacklogEndpoints } from '../../dist/kubernetes/index.js';

const pool = new pg.Pool({
  connectionString: process.env.WORKFLOW_POSTGRES_URL,
});
const config = { jobPrefix: process.env.JOB_PREFIX };
const endpoints = createBacklogEndpoints({ pool, config });

const server = createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const result = await endpoints.respond(req.method ?? 'GET', pathname);
    if (result) return send(result.status, result.body);
    const run = /^\/runs\/(.+)$/.exec(pathname);
    if (run && req.method === 'POST') {
      const world = createWorld({ pool, ...config, deploymentId: run[1] });
      const runId = `wrun_${ulid()}`;
      await world.events.create(runId, {
        eventType: 'run_created',
        specVersion: 2,
        eventData: {
          deploymentId: run[1],
          workflowName: 'kwok-e2e',
          input: new Uint8Array([1]),
        },
      });
      await world.close?.();
      return send(200, { runId });
    }
    const finish = /^\/finish\/(.+)$/.exec(pathname);
    if (finish && req.method === 'POST') {
      await pool.query(
        "UPDATE workflow.workflow_runs SET status = 'completed' WHERE id = $1",
        [finish[1]]
      );
      return send(200, { ok: true });
    }
    send(404, { error: 'not_found' });
  } catch (error) {
    res.writeHead(500);
    res.end(String(error));
  }
});
server.listen(Number(process.env.PORT ?? 3600), '127.0.0.1');
