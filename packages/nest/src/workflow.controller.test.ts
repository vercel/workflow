import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveModuleOptions, setWorkflowBasePath } from './options.js';
import {
  resetWorkflowControllerGlobal,
  WorkflowController,
} from './workflow.controller.js';

function response() {
  const state = {
    status: 0,
    headers: new Map<string, string | string[]>(),
    body: undefined as unknown,
  };
  const res = {
    status(code: number) {
      state.status = code;
      return res;
    },
    setHeader(name: string, value: string | string[]) {
      state.headers.set(name.toLowerCase(), value);
    },
    end(body?: unknown) {
      state.body = body;
    },
  };
  return { res, state };
}

function request(method = 'POST') {
  return {
    method,
    url: '/.well-known/workflow/v1/flow',
    originalUrl: '/.well-known/workflow/v1/flow',
    protocol: 'http',
    headers: { host: 'example.test' },
    body: undefined,
    complete: true,
  };
}

function controller(options: {
  outDir: string;
  generating?: string;
  globalPrefix?: string;
}) {
  // The controller compares the prefix NestJS serves under against the prefix
  // the SDK is generating, which WorkflowModule publishes at startup.
  setWorkflowBasePath(options.generating ?? '');
  const resolved = resolveModuleOptions({ outDir: options.outDir }, {});
  const appConfig = {
    getGlobalPrefix: () => options.globalPrefix ?? '',
  };
  return new WorkflowController(
    resolved,
    appConfig as unknown as ConstructorParameters<typeof WorkflowController>[1]
  );
}

describe('WorkflowController', () => {
  let outDir: string;

  beforeEach(() => {
    outDir = mkdtempSync(join(tmpdir(), 'wf-nest-controller-'));
    resetWorkflowControllerGlobal();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  it('answers 503 with an actionable message when the bundles are missing', async () => {
    // Previously this surfaced as a raw ERR_MODULE_NOT_FOUND 500 that said
    // nothing about the build step that was skipped.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { res, state } = response();
    await controller({ outDir }).handleFlowPost(request(), res);
    expect(state.status).toBe(503);
    expect(String(state.body)).toContain('workflow-nest build');
    expect(error).toHaveBeenCalled();
  });

  it('answers 503 on the webhook route when the bundles are missing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { res, state } = response();
    await controller({ outDir }).handleWebhook(request(), res);
    expect(state.status).toBe(503);
    expect(String(state.body)).toContain('Workflow bundle not found');
  });

  it('reports a global prefix that does not match basePath', async () => {
    // The failure this catches is silent otherwise: runs get created and then
    // every queue delivery 404s against the unprefixed URL.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { res } = response();
    await controller({ outDir, globalPrefix: 'api' }).handleFlowPost(
      request(),
      res
    );
    const messages = error.mock.calls.map((call) => String(call[0]));
    expect(
      messages.some((message) => message.includes('Global prefix mismatch'))
    ).toBe(true);
    expect(
      messages.some((message) => message.includes("basePath: '/api'"))
    ).toBe(true);
  });

  it('stays quiet when the global prefix and basePath agree', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { res } = response();
    await controller({
      outDir,
      generating: '/api',
      globalPrefix: '/api',
    }).handleFlowPost(request(), res);
    const messages = error.mock.calls.map((call) => String(call[0]));
    expect(
      messages.some((message) => message.includes('Global prefix mismatch'))
    ).toBe(false);
  });

  it('exposes flow handlers for every method the bundle exports', () => {
    // HEAD is what getWorkflowPort() probes to identify a workflow server; a
    // 404 there makes local port detection fall back to an arbitrary port.
    const instance = controller({ outDir });
    expect(typeof instance.handleFlowGet).toBe('function');
    expect(typeof instance.handleFlowHead).toBe('function');
    expect(typeof instance.handleFlowOptions).toBe('function');
    expect(typeof instance.handleFlowPost).toBe('function');
  });

  it('gates the manifest behind WORKFLOW_PUBLIC_MANIFEST', () => {
    writeFileSync(join(outDir, 'manifest.json'), '{"version":1}');
    const previous = process.env.WORKFLOW_PUBLIC_MANIFEST;
    try {
      delete process.env.WORKFLOW_PUBLIC_MANIFEST;
      const closed = response();
      controller({ outDir }).handleManifest(closed.res);
      expect(closed.state.status).toBe(404);

      process.env.WORKFLOW_PUBLIC_MANIFEST = '1';
      const open = response();
      controller({ outDir }).handleManifest(open.res);
      expect(open.state.status).toBe(200);
      expect(open.state.headers.get('content-type')).toBe('application/json');
      expect(open.state.body).toBe('{"version":1}');
    } finally {
      if (previous === undefined) {
        delete process.env.WORKFLOW_PUBLIC_MANIFEST;
      } else {
        process.env.WORKFLOW_PUBLIC_MANIFEST = previous;
      }
    }
  });

  it('404s the manifest when the file is absent even if exposure is on', () => {
    const previous = process.env.WORKFLOW_PUBLIC_MANIFEST;
    process.env.WORKFLOW_PUBLIC_MANIFEST = '1';
    try {
      const { res, state } = response();
      controller({ outDir }).handleManifest(res);
      expect(state.status).toBe(404);
    } finally {
      if (previous === undefined) {
        delete process.env.WORKFLOW_PUBLIC_MANIFEST;
      } else {
        process.env.WORKFLOW_PUBLIC_MANIFEST = previous;
      }
    }
  });

  it('explains itself when constructed with no configuration at all', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { res, state } = response();
    const bare = new WorkflowController(undefined, undefined);
    await bare.handleFlowPost(request(), res);
    expect(state.status).toBe(503);
    expect(String(state.body)).toContain(
      'WorkflowController is not configured'
    );
  });
});
