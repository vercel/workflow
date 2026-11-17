import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** The few Kubernetes REST calls pruning needs, by API path. */
export interface KubeApi {
  get<T = unknown>(path: string): Promise<T>;
  create(path: string, body: unknown): Promise<void>;
  /** Resolves when the object is gone, including when it never existed. */
  delete(path: string): Promise<void>;
}

class KubeApiError extends Error {
  override readonly name = 'KubeApiError';
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
  }
}

/** Through `kubectl`, with whatever credentials its context has (a deploy pipeline's, say). */
export function kubectlApi(
  options: { context?: string; kubectl?: string } = {}
): KubeApi {
  const kubectl = options.kubectl ?? 'kubectl';
  const base = options.context ? ['--context', options.context] : [];
  const exec = async (args: string[], input?: string) => {
    const child = run(kubectl, [...base, ...args], {
      maxBuffer: 64 * 1024 * 1024,
    });
    if (input !== undefined) {
      child.child.stdin?.end(input);
    }
    try {
      return (await child).stdout;
    } catch (error) {
      const stderr = String((error as { stderr?: string }).stderr ?? error);
      throw new KubeApiError(
        stderr.trim(),
        /NotFound|\(404\)/.test(stderr) ? 404 : undefined
      );
    }
  };
  return {
    async get<T>(path: string) {
      return JSON.parse(await exec(['get', '--raw', path])) as T;
    },
    async create(path, body) {
      await exec(['create', '--raw', path, '-f', '-'], JSON.stringify(body));
    },
    async delete(path) {
      try {
        await exec(['delete', '--raw', path]);
      } catch (error) {
        if ((error as KubeApiError).status !== 404) throw error;
      }
    },
  };
}

const SA = '/var/run/secrets/kubernetes.io/serviceaccount';

/** From inside a pod, as its service account. */
export function inClusterApi(): KubeApi & { namespace: string } {
  const host = process.env.KUBERNETES_SERVICE_HOST;
  const port = process.env.KUBERNETES_SERVICE_PORT ?? '443';
  if (!host) {
    throw new KubeApiError(
      'Not running in a Kubernetes pod (KUBERNETES_SERVICE_HOST is unset)'
    );
  }
  const ca = readFileSync(`${SA}/ca.crt`);
  const namespace = readFileSync(`${SA}/namespace`, 'utf8').trim();
  const call = (method: string, path: string, body?: unknown) =>
    new Promise<{ status: number; text: string }>((resolve, reject) => {
      // Projected tokens rotate: read it per call.
      const token = readFileSync(`${SA}/token`, 'utf8').trim();
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = request(
        {
          host,
          port,
          path,
          method,
          ca,
          headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/json',
            ...(payload ? { 'content-type': 'application/json' } : {}),
          },
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => (text += chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
        }
      );
      req.on('error', reject);
      req.setTimeout(30_000, () =>
        req.destroy(new Error(`${method} ${path} timed out`))
      );
      req.end(payload);
    });
  const check = (
    method: string,
    path: string,
    { status, text }: { status: number; text: string }
  ) => {
    if (status >= 300) {
      throw new KubeApiError(
        `${method} ${path}: ${status} ${text.slice(0, 500)}`,
        status
      );
    }
    return text;
  };
  return {
    namespace,
    async get<T>(path: string) {
      return JSON.parse(check('GET', path, await call('GET', path))) as T;
    },
    async create(path, body) {
      check('POST', path, await call('POST', path, body));
    },
    async delete(path) {
      const res = await call('DELETE', path);
      if (res.status !== 404) check('DELETE', path, res);
    },
  };
}
