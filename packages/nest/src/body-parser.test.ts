import { describe, expect, it, vi } from 'vitest';
import {
  bypassWorkflowBodyParsers,
  FASTIFY_DEFAULT_BODY_LIMIT,
  fastifyBodyLimitAdvice,
} from './body-parser.js';

type Layer = { name?: string; handle: unknown };

/** A stand-in for the layer stack Express keeps on its router. */
function expressApp(handles: Array<() => void>, key: 'router' | '_router') {
  const stack: Layer[] = handles.map((handle) => ({
    name: handle.name,
    handle,
  }));
  return { [key]: { stack } } as Record<string, { stack: Layer[] }>;
}

function named(name: string) {
  const fn = vi.fn();
  Object.defineProperty(fn, 'name', { value: name });
  return fn as unknown as (() => void) & { mock: { calls: unknown[][] } };
}

function adapterFor(instance: unknown, type: string) {
  return { getType: () => type, getInstance: () => instance };
}

function run(layer: Layer, url: string, headers: Record<string, string> = {}) {
  const next = vi.fn();
  (layer.handle as (r: unknown, s: unknown, n: unknown) => void)(
    { url, headers },
    {},
    next
  );
  return next;
}

describe('bypassWorkflowBodyParsers on Express', () => {
  it.each([
    'router',
    '_router',
  ] as const)('wraps the body parsers reachable through app.%s', (key) => {
    // Express 5 exposes the router directly; Express 4 lazily as `_router`.
    const json = named('jsonParser');
    const app = expressApp([json], key);

    const result = bypassWorkflowBodyParsers(adapterFor(app, 'express'));

    expect(result).toEqual({ platform: 'express', bypassed: ['jsonParser'] });
  });

  it('wraps every parser body-parser can produce and nothing else', () => {
    const app = expressApp(
      [
        named('jsonParser'),
        named('urlencodedParser'),
        named('textParser'),
        named('rawParser'),
        named('corsMiddleware'),
        named('helmetMiddleware'),
      ],
      'router'
    );

    const result = bypassWorkflowBodyParsers(adapterFor(app, 'express'));

    expect(result).toEqual({
      platform: 'express',
      bypassed: ['jsonParser', 'urlencodedParser', 'textParser', 'rawParser'],
    });
  });

  it('calls next() for a workflow route and the parser for anything else', () => {
    const json = named('jsonParser');
    const app = expressApp([json], 'router');
    bypassWorkflowBodyParsers(adapterFor(app, 'express'));
    const layer = app.router.stack[0];

    expect(run(layer, '/.well-known/workflow/v1/flow')).toHaveBeenCalledOnce();
    expect(json.mock.calls).toHaveLength(0);

    expect(run(layer, '/orders')).not.toHaveBeenCalled();
    expect(json.mock.calls).toHaveLength(1);
  });

  it('still parses a compressed workflow body', () => {
    // Nothing downstream of the bypass inflates `content-encoding`, so a
    // compressed body has to keep going through the parser or the workflow
    // receives bytes it cannot read.
    const json = named('jsonParser');
    const app = expressApp([json], 'router');
    bypassWorkflowBodyParsers(adapterFor(app, 'express'));
    const layer = app.router.stack[0];

    run(layer, '/.well-known/workflow/v1/flow', { 'content-encoding': 'gzip' });
    expect(json.mock.calls).toHaveLength(1);

    run(layer, '/.well-known/workflow/v1/flow', {
      'content-encoding': 'identity',
    });
    expect(json.mock.calls).toHaveLength(1);
  });

  it('is idempotent', () => {
    // `forRoot()` can be imported by more than one module, and the module can
    // be re-initialized in a test harness.
    const app = expressApp([named('jsonParser')], 'router');
    const adapter = adapterFor(app, 'express');

    expect(bypassWorkflowBodyParsers(adapter)).toEqual({
      platform: 'express',
      bypassed: ['jsonParser'],
    });
    expect(bypassWorkflowBodyParsers(adapter)).toEqual({
      platform: 'express',
      bypassed: [],
    });
  });

  it('reports nothing when the app has no parsers', () => {
    // `NestFactory.create(AppModule, { bodyParser: false })`.
    expect(
      bypassWorkflowBodyParsers(adapterFor(expressApp([], 'router'), 'express'))
    ).toEqual({ platform: 'express', bypassed: [] });
  });

  it('does not report a parser it could not replace', () => {
    // Defensive: a future Express could expose `handle` as a getter.
    const stack: Layer[] = [
      { name: 'jsonParser', handle: named('jsonParser') },
    ];
    Object.defineProperty(stack[0], 'handle', {
      get: () => named('jsonParser'),
      set: () => {},
    });

    expect(
      bypassWorkflowBodyParsers(adapterFor({ router: { stack } }, 'express'))
    ).toEqual({ platform: 'express', bypassed: [] });
  });

  it('accepts a Nest application, an adapter, or the raw instance', () => {
    const adapter = adapterFor(
      expressApp([named('jsonParser')], 'router'),
      'express'
    );
    expect(
      bypassWorkflowBodyParsers({ getHttpAdapter: () => adapter })
    ).toEqual({ platform: 'express', bypassed: ['jsonParser'] });
    expect(
      bypassWorkflowBodyParsers(expressApp([named('jsonParser')], 'router'))
    ).toEqual({ platform: 'express', bypassed: ['jsonParser'] });
  });
});

describe('bypassWorkflowBodyParsers on Fastify', () => {
  it('reports the body limit without patching anything', () => {
    expect(
      bypassWorkflowBodyParsers(
        adapterFor({ initialConfig: { bodyLimit: 1024 } }, 'fastify')
      )
    ).toEqual({ platform: 'fastify', bodyLimit: 1024 });
  });

  it('reports an unreadable limit as undefined', () => {
    expect(bypassWorkflowBodyParsers(adapterFor({}, 'fastify'))).toEqual({
      platform: 'fastify',
      bodyLimit: undefined,
    });
  });
});

describe('bypassWorkflowBodyParsers on an unknown platform', () => {
  it('does nothing', () => {
    expect(bypassWorkflowBodyParsers(adapterFor({}, 'something-else'))).toEqual(
      {
        platform: 'unknown',
      }
    );
    expect(bypassWorkflowBodyParsers(undefined)).toEqual({
      platform: 'unknown',
    });
  });
});

describe('fastifyBodyLimitAdvice', () => {
  it('advises at or below the Fastify default', () => {
    expect(fastifyBodyLimitAdvice(FASTIFY_DEFAULT_BODY_LIMIT)).toContain(
      'bodyLimit'
    );
    expect(fastifyBodyLimitAdvice(1024)).toContain('bodyLimit');
  });

  it('stays quiet once the limit is raised, or unknown', () => {
    expect(
      fastifyBodyLimitAdvice(FASTIFY_DEFAULT_BODY_LIMIT + 1)
    ).toBeUndefined();
    expect(fastifyBodyLimitAdvice(undefined)).toBeUndefined();
  });
});
