/**
 * End-to-end coverage of `WorkflowModule` inside a real NestJS application, on
 * both official platforms.
 *
 * The unit tests elsewhere in this package drive the controller with fake
 * request objects, which cannot see any of the failures that live in NestJS's
 * own route registration, guard pipeline and body parsing. Everything here
 * boots an actual HTTP server and talks to it over the network, because that
 * is the only place those failures show up.
 *
 * Decorators are applied as function calls rather than with `@` syntax: these
 * test files are excluded from the package's tsconfig, so the esbuild
 * transform vitest uses has no `experimentalDecorators` to honour.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import {
  All,
  Controller,
  Injectable,
  Module,
  Post,
  Req,
  Res,
  VersioningType,
} from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowModule } from './workflow.module.js';
import { isWorkflowRequest } from './workflow-routes.js';

/**
 * Write a stand-in for the generated bundles. The flow handler echoes what the
 * controller handed it, so a test can assert on the bytes and the method that
 * survived the Node-to-WHATWG conversion.
 */
function writeBundles(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wf-nest-app-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'steps.mjs'), 'export const __steps = true;\n');
  writeFileSync(
    join(dir, 'workflows.mjs'),
    [
      'const handler = async (request) => {',
      '  const body = request.body',
      '    ? new TextDecoder().decode(new Uint8Array(await request.arrayBuffer()))',
      '    : "";',
      '  return Response.json({ url: request.url, method: request.method, body });',
      '};',
      'export const GET = handler;',
      'export const HEAD = handler;',
      'export const OPTIONS = handler;',
      'export const POST = handler;',
    ].join('\n')
  );
  writeFileSync(
    join(dir, 'webhook.mjs'),
    [
      'const handler = async (request) => Response.json({',
      '  url: request.url,',
      '  body: await request.text(),',
      '});',
      'export const GET = handler;',
      'export const HEAD = handler;',
      'export const OPTIONS = handler;',
      'export const POST = handler;',
    ].join('\n')
  );
  writeFileSync(join(dir, 'manifest.json'), '{}');
  return dir;
}

function rootModule(
  outDir: string,
  moduleOptions: Record<string, unknown> = {},
  metadata: Record<string, unknown> = {}
) {
  class RootModule {}
  Module({
    imports: [
      WorkflowModule.forRoot({
        outDir,
        skipBuild: true,
        preloadBundles: false,
        ...moduleOptions,
      }),
    ],
    ...metadata,
  } as never)(RootModule);
  return RootModule;
}

const open: INestApplication[] = [];

async function serve(app: INestApplication): Promise<string> {
  open.push(app);
  await app.listen(0, '127.0.0.1');
  // `getUrl()` reports the IPv6 loopback on dual-stack hosts, which `fetch`
  // declines to parse.
  return (await app.getUrl()).replace('[::1]', '127.0.0.1');
}

afterEach(async () => {
  for (const app of open.splice(0)) {
    await app.close().catch(() => {});
  }
  // Console spies are shared per module, so a surviving spy would carry one
  // test's calls into the next one's assertions.
  vi.restoreAllMocks();
});

async function post(
  base: string,
  path: string,
  body?: string,
  headers: Record<string, string> = {}
) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
  return { status: response.status, text: await response.text() };
}

const FLOW = '/.well-known/workflow/v1/flow';

describe('WorkflowModule on Express', () => {
  it('serves the workflow routes', async () => {
    const base = await serve(
      await NestFactory.create(rootModule(writeBundles()), { logger: false })
    );

    const flow = await post(base, FLOW, '{"hello":"world"}');
    expect(flow.status).toBe(200);
    expect(JSON.parse(flow.text).method).toBe('POST');

    const head = await fetch(`${base}${FLOW}`, { method: 'HEAD' });
    expect(head.status).toBe(200);

    const webhook = await post(
      base,
      '/.well-known/workflow/v1/webhook/tok',
      '{"event":"ping"}'
    );
    expect(webhook.status).toBe(200);
  });

  it('accepts bodies larger than the Express body-parser limit', async () => {
    // Express's parser caps bodies at 100 KB, and NestJS installs it by
    // default. Queue deliveries carry run and step payloads in the body, so
    // without the bypass a workflow passing more than that around is answered
    // with 413 and never progresses. 150 KB is just over the limit; 2 MB is
    // well clear of it.
    const base = await serve(
      await NestFactory.create(rootModule(writeBundles()), { logger: false })
    );

    for (const size of [150_000, 2_000_000]) {
      const body = JSON.stringify({ blob: 'x'.repeat(size) });
      const response = await post(base, FLOW, body);
      expect(response.status).toBe(200);
      expect(JSON.parse(response.text).body).toHaveLength(body.length);
    }
  });

  it('delivers the exact bytes a webhook was signed over, with no rawBody option', async () => {
    // Re-serializing a parsed body reorders keys and drops whitespace, which
    // breaks every HMAC-over-the-raw-body scheme. Bypassing the parser leaves
    // the stream for the controller, so the bytes survive without the app
    // having to opt into `{ rawBody: true }`.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const base = await serve(
      await NestFactory.create(rootModule(writeBundles()), { logger: false })
    );

    const signed = '{"b":1,   "a":2}';
    const response = await post(
      base,
      '/.well-known/workflow/v1/webhook/tok',
      signed
    );

    expect(JSON.parse(response.text).body).toBe(signed);
    expect(
      warn.mock.calls.some((call) => String(call[0]).includes('re-serialized'))
    ).toBe(false);
  });

  it('leaves the application’s own routes parsed and size-limited', async () => {
    // The bypass is scoped to the workflow routes. An app that chose a small
    // limit keeps it everywhere else.
    class EchoController {
      echo(_request: unknown, response: { status: (code: number) => unknown }) {
        response.status(204);
        (response as unknown as { end: () => void }).end();
      }
    }
    Req()(EchoController.prototype, 'echo', 0);
    Res()(EchoController.prototype, 'echo', 1);
    Post()(
      EchoController.prototype,
      'echo',
      Object.getOwnPropertyDescriptor(EchoController.prototype, 'echo')
    );
    Controller('echo')(EchoController);

    const base = await serve(
      await NestFactory.create(
        rootModule(writeBundles(), {}, { controllers: [EchoController] }),
        { logger: false }
      )
    );

    expect((await post(base, '/echo', '{"a":1}')).status).toBe(204);
    const big = await post(
      base,
      '/echo',
      JSON.stringify({ blob: 'x'.repeat(200_000) })
    );
    expect(big.status).toBe(413);
  });

  it('keeps the parser when bypassBodyParser is turned off', async () => {
    const base = await serve(
      await NestFactory.create(
        rootModule(writeBundles(), { bypassBodyParser: false }),
        { logger: false }
      )
    );

    const big = await post(
      base,
      FLOW,
      JSON.stringify({ blob: 'x'.repeat(200_000) })
    );
    expect(big.status).toBe(413);
  });

  it('keeps serving the workflow routes under URI versioning', async () => {
    // `enableVersioning()` prefixes every route with the version, but the SDK
    // generates its callback URLs at a fixed path, so a versioned workflow
    // route is a route no delivery can reach. The controller is declared
    // VERSION_NEUTRAL to stay put.
    const app = await NestFactory.create(rootModule(writeBundles()), {
      logger: false,
    });
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    const base = await serve(app);

    expect((await post(base, FLOW, '{}')).status).toBe(200);
    expect((await post(base, `/v1${FLOW}`, '{}')).status).toBe(404);
  });

  it('composes the global prefix with URI versioning', async () => {
    const app = await NestFactory.create(rootModule(writeBundles()), {
      logger: false,
    });
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '2' });
    const base = await serve(app);

    expect((await post(base, `/api${FLOW}`, '{}')).status).toBe(200);
    expect((await post(base, `/api/v2${FLOW}`, '{}')).status).toBe(404);
  });

  it('generates URLs at the origin root when the global prefix excludes the workflow routes', async () => {
    // `setGlobalPrefix(prefix, { exclude })` leaves the excluded routes at the
    // root. Adopting the prefix anyway would point every generated callback at
    // a path NestJS does not route — and the startup log would claim success.
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const app = await NestFactory.create(rootModule(writeBundles()), {
      logger: false,
    });
    app.setGlobalPrefix('api', { exclude: ['.well-known/workflow/v1/(.*)'] });
    const base = await serve(app);

    expect((await post(base, FLOW, '{}')).status).toBe(200);
    expect((await post(base, `/api${FLOW}`, '{}')).status).toBe(404);
    expect(
      log.mock.calls.some((call) =>
        String(call[0]).includes('excludes the workflow routes')
      )
    ).toBe(true);
  });

  it('lets a guard recognise workflow requests', async () => {
    // A global guard runs before the controller, so an app that authenticates
    // every request rejects queue deliveries too. `isWorkflowRequest()` is the
    // supported way to let them through.
    class AuthGuard {
      canActivate(context: never): boolean {
        return isWorkflowRequest(context);
      }
    }
    Injectable()(AuthGuard);

    class OtherController {
      everything(_request: unknown, response: { status: (c: number) => void }) {
        response.status(204);
        (response as unknown as { end: () => void }).end();
      }
    }
    Req()(OtherController.prototype, 'everything', 0);
    Res()(OtherController.prototype, 'everything', 1);
    // Includes a wildcard, the shape that can be reached through a URL
    // containing the workflow segment.
    All(['', '*path'])(
      OtherController.prototype,
      'everything',
      Object.getOwnPropertyDescriptor(OtherController.prototype, 'everything')
    );
    Controller('private')(OtherController);

    const base = await serve(
      await NestFactory.create(
        rootModule(
          writeBundles(),
          {},
          {
            controllers: [OtherController],
            providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
          }
        ),
        { logger: false }
      )
    );

    expect((await post(base, FLOW, '{}')).status).toBe(200);
    expect(
      (await post(base, '/.well-known/workflow/v1/webhook/tok', '{"a":1}'))
        .status
    ).toBe(200);
    expect((await post(base, '/private', '{}')).status).toBe(403);
    // A wildcard application route reached through a URL that contains the
    // workflow segment is still the application's route, and still guarded.
    expect((await post(base, `/private/x${FLOW}`, '{}')).status).toBe(403);
  });

  it('parses a compressed body rather than passing bytes nothing can read', async () => {
    // `body-parser` inflates `content-encoding`; the bypass does not. A
    // compressed body therefore keeps going through the parser.
    const { gzipSync } = await import('node:zlib');
    const base = await serve(
      await NestFactory.create(rootModule(writeBundles()), { logger: false })
    );

    const response = await fetch(`${base}${FLOW}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
      },
      body: gzipSync(Buffer.from('{"hello":"world"}')),
    });

    expect(response.status).toBe(200);
    expect(JSON.parse(await response.text()).body).toBe('{"hello":"world"}');
  });
});

describe('WorkflowModule on Fastify', () => {
  async function fastifyApp(
    outDir: string,
    adapterOptions?: Record<string, unknown>,
    moduleOptions: Record<string, unknown> = {}
  ) {
    const { FastifyAdapter } = await import('@nestjs/platform-fastify');
    return NestFactory.create(
      rootModule(outDir, moduleOptions),
      new FastifyAdapter(adapterOptions),
      { logger: false }
    );
  }

  it('boots and serves every workflow route', async () => {
    // Fastify derives a HEAD route from each GET route, so declaring the GET
    // handler before the HEAD handler makes route registration throw
    // `Method 'HEAD' already declared` and rejects `app.init()` — the whole
    // application fails to start, not just the workflow routes.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const base = await serve(await fastifyApp(writeBundles()));

    const flow = await post(base, FLOW, '{"hello":"world"}');
    expect(flow.status).toBe(200);
    expect(JSON.parse(flow.text).method).toBe('POST');

    expect((await fetch(`${base}${FLOW}`, { method: 'HEAD' })).status).toBe(
      200
    );
    expect((await fetch(`${base}${FLOW}`, { method: 'GET' })).status).toBe(200);
    expect(
      (await post(base, '/.well-known/workflow/v1/webhook/tok', '{"a":1}'))
        .status
    ).toBe(200);

    // Fastify's 1 MiB default is low enough to reject deliveries, and nothing
    // in the integration can scope a Fastify body limit to one route, so it is
    // reported instead.
    expect(
      warn.mock.calls.some((call) =>
        String(call[0]).includes('Fastify rejects request bodies')
      )
    ).toBe(true);
  });

  it('stays quiet when the adapter raises the body limit', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await serve(
      await fastifyApp(writeBundles(), { bodyLimit: 16 * 1024 * 1024 })
    );

    expect(
      warn.mock.calls.some((call) =>
        String(call[0]).includes('Fastify rejects request bodies')
      )
    ).toBe(false);
  });

  it('keeps the workflow routes unversioned', async () => {
    const app = await fastifyApp(writeBundles());
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    const base = await serve(app);

    expect((await post(base, FLOW, '{}')).status).toBe(200);
  });
});
