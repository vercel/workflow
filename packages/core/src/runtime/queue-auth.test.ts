import { metrics as otelMetrics } from '@opentelemetry/api';
import {
  getQueueAuthKey,
  isQueueAuthRefusal,
  QUEUE_AUTH_HEADER,
  QUEUE_AUTH_REFUSED_CODE,
  QUEUE_AUTH_REFUSED_HEADER,
  resetGlobalSingletonForTest,
} from '@workflow/utils';
import { type QueueAuthMode, SPEC_VERSION_CURRENT } from '@workflow/world';
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { runtimeLogger } from '../logger.js';
import { workflowEntrypoint } from '../runtime.js';
import {
  authorizeQueueDelivery,
  createQueueAuthRefusalLogger,
  isQueueAuthEnforced,
  logQueueAuthSetting,
} from './queue-auth.js';
import { setWorld } from './world.js';

// Registered before the runtime first reaches for its meter, which it
// memoizes. Records what the refusal counter is given.
const counterAdds = vi.fn();
const meter = {
  createCounter: vi.fn(() => ({ add: counterAdds })),
  createHistogram: vi.fn(() => ({ record: vi.fn() })),
};
otelMetrics.setGlobalMeterProvider({ getMeter: () => meter } as any);
afterAll(() => {
  otelMetrics.disable();
});

const FLOW_URL = 'http://localhost:3000/.well-known/workflow/v1/flow';

function delivery(headers: Record<string, string> = {}): Request {
  return new Request(FLOW_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ runId: 'wrun_forged' }),
  });
}

const withKey = () => delivery({ [QUEUE_AUTH_HEADER]: getQueueAuthKey() });

beforeEach(() => {
  vi.stubEnv('WORKFLOW_QUEUE_AUTH', undefined);
  vi.stubEnv('WORKFLOW_EXPERIMENTAL_DYNAMIC_WORKFLOWS', undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
  resetGlobalSingletonForTest(
    '@workflow/core//undeclaredQueueAuthModeWarning',
    1
  );
});

const undeclaredWarning = expect.stringContaining('declares no queueAuthMode');

describe('isQueueAuthEnforced', () => {
  it.each<[QueueAuthMode | undefined, boolean]>([
    ['loopback', true],
    // Opt-in: a World that declares nothing is not checked.
    [undefined, false],
    ['skip', false],
  ])('mode %s: enforced=%s by default', (mode, enforced) => {
    expect(isQueueAuthEnforced({ queueAuthMode: mode })).toBe(enforced);
  });

  it('WORKFLOW_QUEUE_AUTH=off turns it off, in any case', () => {
    for (const value of ['off', 'OFF', ' Off ']) {
      vi.stubEnv('WORKFLOW_QUEUE_AUTH', value);
      expect(isQueueAuthEnforced({ queueAuthMode: 'loopback' })).toBe(false);
    }
  });

  it('any other value leaves it on', () => {
    for (const value of ['on', '', '0', 'false', 'disabled']) {
      vi.stubEnv('WORKFLOW_QUEUE_AUTH', value);
      expect(isQueueAuthEnforced({ queueAuthMode: 'loopback' })).toBe(true);
    }
  });

  it('refuses off while dynamic workflows are enabled, read on every call', () => {
    const world = { queueAuthMode: 'loopback' as const };
    vi.stubEnv('WORKFLOW_QUEUE_AUTH', 'off');
    expect(isQueueAuthEnforced(world)).toBe(false);
    vi.stubEnv('WORKFLOW_EXPERIMENTAL_DYNAMIC_WORKFLOWS', '1');
    expect(isQueueAuthEnforced(world)).toBe(true);
    vi.stubEnv('WORKFLOW_EXPERIMENTAL_DYNAMIC_WORKFLOWS', 'true');
    expect(isQueueAuthEnforced(world)).toBe(true);
    vi.stubEnv('WORKFLOW_EXPERIMENTAL_DYNAMIC_WORKFLOWS', '0');
    expect(isQueueAuthEnforced(world)).toBe(false);
  });
});

describe('authorizeQueueDelivery', () => {
  const world = { queueAuthMode: 'loopback' as const };

  it('lets a delivery carrying the key through', async () => {
    expect(await authorizeQueueDelivery(world, withKey())).toBeUndefined();
  });

  it.each([
    ['no header', {}],
    ['an empty header', { [QUEUE_AUTH_HEADER]: '' }],
    ['a wrong key', { [QUEUE_AUTH_HEADER]: 'x'.repeat(43) }],
    ['a truncated key', { [QUEUE_AUTH_HEADER]: getQueueAuthKey().slice(1) }],
  ])('refuses %s with a marked 401', async (_name, headers) => {
    const refusal = await authorizeQueueDelivery(world, delivery(headers));
    expect(refusal?.response.status).toBe(401);
    // Marked, so the sending queue gives the message up instead of retrying
    // it: the refusal cannot change on redelivery.
    expect(refusal?.response.headers.get(QUEUE_AUTH_REFUSED_HEADER)).toBe('1');
    expect(refusal && isQueueAuthRefusal(refusal.response)).toBe(true);
    await expect(refusal?.response.json()).resolves.toEqual({
      error: 'Unauthorized queue delivery',
      code: QUEUE_AUTH_REFUSED_CODE,
    });
  });

  it.each([
    ['no-key', {}],
    ['no-key', { [QUEUE_AUTH_HEADER]: '' }],
    ['wrong-key', { [QUEUE_AUTH_HEADER]: 'x'.repeat(43) }],
  ])('reports %s', async (reason, headers) => {
    expect(
      (await authorizeQueueDelivery(world, delivery(headers)))?.reason
    ).toBe(reason);
  });

  it("does not check a World that declares 'skip'", async () => {
    expect(
      await authorizeQueueDelivery({ queueAuthMode: 'skip' }, delivery())
    ).toBe(undefined);
  });
});

describe('logQueueAuthSetting', () => {
  it('warns once for several route startups at once when the World declares no mode', () => {
    const warn = vi.spyOn(runtimeLogger, 'warn').mockImplementation(() => {});
    // Several route copies (bundler layers) initializing at startup.
    logQueueAuthSetting({});
    logQueueAuthSetting({});
    logQueueAuthSetting({ queueAuthMode: undefined });

    expect(warn).toHaveBeenCalledTimes(1);
    const [message] = warn.mock.calls[0] as [string];
    expect(message).toContain(
      'does not authenticate deliveries to the flow route'
    );
    expect(message).toContain('/.well-known/workflow/v1/flow');
    expect(message).toContain('network edge');
    expect(message).toContain('required in Workflow SDK v6');
  });

  it('warns again at most once a minute, with the count since', () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(runtimeLogger, 'warn').mockImplementation(() => {});
    logQueueAuthSetting({});
    logQueueAuthSetting({});
    vi.advanceTimersByTime(61_000);
    logQueueAuthSetting({});

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1]?.[1]).toEqual({ routesSinceLastLog: 2 });
  });

  it('gives a loopback or skip World no such warning', () => {
    const warn = vi.spyOn(runtimeLogger, 'warn');
    logQueueAuthSetting({ queueAuthMode: 'loopback' });
    logQueueAuthSetting({ queueAuthMode: 'skip' });
    expect(warn).not.toHaveBeenCalledWith(undeclaredWarning, expect.anything());
  });

  it('is silent by default and for skip Worlds', () => {
    const warn = vi.spyOn(runtimeLogger, 'warn');
    const error = vi.spyOn(runtimeLogger, 'error');
    logQueueAuthSetting({ queueAuthMode: 'loopback' });
    vi.stubEnv('WORKFLOW_QUEUE_AUTH', 'off');
    logQueueAuthSetting({ queueAuthMode: 'skip' });
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('warns loudly when off', () => {
    const warn = vi.spyOn(runtimeLogger, 'warn');
    vi.stubEnv('WORKFLOW_QUEUE_AUTH', 'off');
    logQueueAuthSetting({ queueAuthMode: 'loopback' });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('QUEUE DELIVERY AUTHENTICATION IS OFF')
    );
  });

  it('logs an error when off is refused under dynamic workflows', () => {
    const error = vi.spyOn(runtimeLogger, 'error');
    vi.stubEnv('WORKFLOW_QUEUE_AUTH', 'off');
    vi.stubEnv('WORKFLOW_EXPERIMENTAL_DYNAMIC_WORKFLOWS', '1');
    logQueueAuthSetting({ queueAuthMode: 'loopback' });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('is refused'));
  });

  it('warns about an unrecognized value', () => {
    const warn = vi.spyOn(runtimeLogger, 'warn');
    vi.stubEnv('WORKFLOW_QUEUE_AUTH', 'disabled');
    logQueueAuthSetting({ queueAuthMode: 'loopback' });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Unrecognized WORKFLOW_QUEUE_AUTH value')
    );
  });
});

describe('createQueueAuthRefusalLogger', () => {
  it('logs the first refusal, then at most once a minute with a count', () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(runtimeLogger, 'warn');
    const logRefusal = createQueueAuthRefusalLogger();
    logRefusal();
    logRefusal();
    logRefusal();
    expect(warn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    logRefusal();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1]?.[1]).toEqual({ refusedSinceLastLog: 3 });
  });
});

describe('workflowEntrypoint queue auth', () => {
  /**
   * A World whose queue route records each request it is handed and whose
   * storage records every write, so a test sees whether a refused request
   * reached the handler or touched a run.
   */
  function installWorld(queueAuthMode: QueueAuthMode | undefined) {
    const routed: Request[] = [];
    const writes = vi.fn();
    setWorld({
      ...(queueAuthMode === undefined ? {} : { queueAuthMode }),
      specVersion: SPEC_VERSION_CURRENT,
      getDeploymentId: async () => 'dpl_test',
      createQueueHandler: vi.fn(() => async (req: Request) => {
        routed.push(req);
        return Response.json({ ok: true });
      }),
      events: { create: writes, list: writes },
      runs: { get: writes },
      queue: writes,
    } as any);
    const route = workflowEntrypoint(
      'globalThis.__private_workflows = new Map();'
    );
    return { routed, writes, route };
  }

  it('refuses a request without the key before the handler sees it', async () => {
    vi.spyOn(runtimeLogger, 'warn').mockImplementation(() => {});
    const { routed, writes, route } = installWorld('loopback');

    const response = await route(delivery());

    expect(response.status).toBe(401);
    expect(isQueueAuthRefusal(response)).toBe(true);
    expect(routed).toHaveLength(0);
    expect(writes).not.toHaveBeenCalled();
  });

  it('counts every refusal by world, route and reason', async () => {
    vi.spyOn(runtimeLogger, 'warn').mockImplementation(() => {});
    vi.stubEnv('WORKFLOW_TARGET_WORLD', 'local');
    counterAdds.mockClear();
    const { route } = installWorld('loopback');

    await route(delivery());
    await route(delivery({ [QUEUE_AUTH_HEADER]: 'x'.repeat(43) }));
    await route(withKey());
    // The counter is recorded without awaiting it.
    await vi.waitFor(() => expect(counterAdds).toHaveBeenCalledTimes(2));

    expect(meter.createCounter).toHaveBeenCalledWith(
      'workflow.queue.delivery.refused',
      expect.objectContaining({ unit: '{delivery}' })
    );
    const attributes = (reason: string) => ({
      'workflow.world': 'local',
      'http.route': '/.well-known/workflow/v1/flow',
      'workflow.queue.refusal_reason': reason,
    });
    expect(counterAdds).toHaveBeenNthCalledWith(1, 1, attributes('no-key'));
    expect(counterAdds).toHaveBeenNthCalledWith(2, 1, attributes('wrong-key'));
  });

  // The route label must not come from the request: a router can send many
  // path spellings to one handler, and each would be a new metric series.
  it('labels every refusal with the route template, whatever the request path', async () => {
    vi.spyOn(runtimeLogger, 'warn').mockImplementation(() => {});
    counterAdds.mockClear();
    const { route } = installWorld('loopback');

    for (const path of [
      '/.well-known/workflow/v1/flow',
      '/.well-known/workflow/v1/flow/',
      '/.well-known/workflow/v1/flow//',
      '/.well-known/workflow/v1/flow/x/../',
      '/anything-a-forger-picks',
    ]) {
      const response = await route(
        new Request(`http://localhost:3000${path}`, {
          method: 'POST',
          body: '{}',
        })
      );
      expect(response.status).toBe(401);
    }
    await vi.waitFor(() => expect(counterAdds).toHaveBeenCalledTimes(5));

    const routes = new Set(
      counterAdds.mock.calls.map(
        ([, attributes]) => (attributes as Record<string, string>)['http.route']
      )
    );
    expect([...routes]).toEqual(['/.well-known/workflow/v1/flow']);
  });

  it('counts each refusal even while the log is rate-limited', async () => {
    const warn = vi.spyOn(runtimeLogger, 'warn').mockImplementation(() => {});
    counterAdds.mockClear();
    const { route } = installWorld('loopback');

    for (let i = 0; i < 5; i++) await route(delivery());
    await vi.waitFor(() => expect(counterAdds).toHaveBeenCalledTimes(5));

    expect(
      warn.mock.calls.filter(([message]) =>
        String(message).startsWith('Refused an unauthenticated queue delivery')
      )
    ).toHaveLength(1);
  });

  // Opt-in until the mode is required: a World that declares nothing is not
  // checked, so a forged request reaches its handler as it does on main.
  it('does not check a World that declares no mode, and warns once that /flow is unauthenticated', async () => {
    const warn = vi.spyOn(runtimeLogger, 'warn').mockImplementation(() => {});
    const { routed, route } = installWorld(undefined);

    // Opt-in unchanged: an unauthenticated delivery is routed.
    expect((await route(delivery())).status).toBe(200);
    expect((await route(delivery())).status).toBe(200);
    expect(routed).toHaveLength(2);
    expect(
      warn.mock.calls.filter(([message]) =>
        String(message).includes('declares no queueAuthMode')
      )
    ).toHaveLength(1);
  });

  it('hands a delivery carrying the key to the handler', async () => {
    const { routed, route } = installWorld('loopback');

    const response = await route(withKey());

    expect(response.status).toBe(200);
    expect(routed).toHaveLength(1);
  });

  it("hands every request to the handler of a 'skip' World", async () => {
    const { routed, route } = installWorld('skip');

    expect((await route(delivery())).status).toBe(200);
    expect(routed).toHaveLength(1);
  });

  it('WORKFLOW_QUEUE_AUTH=off lets an unauthenticated request through', async () => {
    vi.spyOn(runtimeLogger, 'warn').mockImplementation(() => {});
    vi.stubEnv('WORKFLOW_QUEUE_AUTH', 'off');
    const { routed, route } = installWorld('loopback');

    expect((await route(delivery())).status).toBe(200);
    expect(routed).toHaveLength(1);
  });

  it('refuses off at delivery time once dynamic workflows are enabled', async () => {
    vi.spyOn(runtimeLogger, 'warn').mockImplementation(() => {});
    vi.stubEnv('WORKFLOW_QUEUE_AUTH', 'off');
    const { routed, route } = installWorld('loopback');
    expect((await route(delivery())).status).toBe(200);

    // Enabled after the route was built: read per delivery, not at boot.
    vi.stubEnv('WORKFLOW_EXPERIMENTAL_DYNAMIC_WORKFLOWS', '1');
    expect((await route(delivery())).status).toBe(401);
    expect(routed).toHaveLength(1);
  });

  it('leaves the ?__health probe unauthenticated: it touches nothing', async () => {
    const { routed, writes, route } = installWorld('loopback');

    const response = await route(new Request(`${FLOW_URL}?__health`));

    expect(response.status).toBe(200);
    expect(routed).toHaveLength(0);
    expect(writes).not.toHaveBeenCalled();
  });
});
