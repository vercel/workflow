import { spawn } from 'node:child_process';
import { mkdtemp, mkdir } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveBaseUrl } from './config';

// Mock the getWorkflowPort function from @workflow/utils/get-port
vi.mock('@workflow/utils/get-port', () => ({
  getWorkflowPort: vi.fn(),
}));

describe('resolveBaseUrl', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let originalArgv: string[];

  beforeEach(() => {
    originalEnv = { ...process.env };
    originalArgv = [...process.argv];
  });

  afterEach(() => {
    process.env = originalEnv;
    process.argv = originalArgv;
    vi.clearAllMocks();
  });

  describe('priority order', () => {
    it('should prioritize config.baseUrl over all other options', async () => {
      const { getWorkflowPort } = await import('@workflow/utils/get-port');
      vi.mocked(getWorkflowPort).mockResolvedValue(5173);
      process.env.PORT = '8080';

      const result = await resolveBaseUrl({
        baseUrl: 'https://custom.example.com:3000',
        port: 4000,
      });

      expect(result).toBe('https://custom.example.com:3000');
      expect(getWorkflowPort).not.toHaveBeenCalled();
    });

    it('should use config.port when baseUrl is not provided', async () => {
      const { getWorkflowPort } = await import('@workflow/utils/get-port');
      vi.mocked(getWorkflowPort).mockResolvedValue(5173);
      process.env.PORT = '8080';

      const result = await resolveBaseUrl({
        port: 4000,
      });

      expect(result).toBe('http://localhost:4000');
      expect(getWorkflowPort).not.toHaveBeenCalled();
    });

    it('should use PORT env var when neither baseUrl nor port is provided', async () => {
      const { getWorkflowPort } = await import('@workflow/utils/get-port');
      vi.mocked(getWorkflowPort).mockResolvedValue(5173);
      process.env.PORT = '8080';

      const result = await resolveBaseUrl({});

      expect(result).toBe('http://localhost:8080');
      expect(getWorkflowPort).not.toHaveBeenCalled();
    });

    it('should use auto-detected port when PORT env var is not set', async () => {
      const { getWorkflowPort } = await import('@workflow/utils/get-port');
      vi.mocked(getWorkflowPort).mockResolvedValue(5173);
      delete process.env.PORT;

      const result = await resolveBaseUrl({});

      expect(result).toBe('http://localhost:5173');
      expect(getWorkflowPort).toHaveBeenCalled();
    });

    it('should throw error when all detection methods fail', async () => {
      const { getWorkflowPort } = await import('@workflow/utils/get-port');
      vi.mocked(getWorkflowPort).mockResolvedValue(undefined);
      delete process.env.PORT;

      await expect(resolveBaseUrl({})).rejects.toThrow(
        'Unable to resolve base URL for workflow queue.'
      );
      expect(getWorkflowPort).toHaveBeenCalled();
    });
  });

  describe('baseUrl configuration', () => {
    it('should support HTTPS URLs', async () => {
      const result = await resolveBaseUrl({
        baseUrl: 'https://localhost:3000',
      });

      expect(result).toBe('https://localhost:3000');
    });

    it('should support custom hostnames', async () => {
      const result = await resolveBaseUrl({
        baseUrl: 'https://local.example.com:3000',
      });

      expect(result).toBe('https://local.example.com:3000');
    });

    it('should support non-standard ports in baseUrl', async () => {
      const result = await resolveBaseUrl({
        baseUrl: 'http://localhost:8888',
      });

      expect(result).toBe('http://localhost:8888');
    });

    it('should support baseUrl without port', async () => {
      const result = await resolveBaseUrl({
        baseUrl: 'https://example.com',
      });

      expect(result).toBe('https://example.com');
    });
  });

  describe('port configuration', () => {
    it('should construct URL with port when provided', async () => {
      const result = await resolveBaseUrl({
        port: 5173,
      });

      expect(result).toBe('http://localhost:5173');
    });

    it('should treat port 0 as invalid and fall back to auto-detection', async () => {
      const { getWorkflowPort } = await import('@workflow/utils/get-port');
      vi.mocked(getWorkflowPort).mockResolvedValue(5173);

      const result = await resolveBaseUrl({
        port: 0,
      });

      expect(result).toBe('http://localhost:5173');
      expect(getWorkflowPort).toHaveBeenCalled();
    });

    it('should handle port 80', async () => {
      const result = await resolveBaseUrl({
        port: 80,
      });

      expect(result).toBe('http://localhost:80');
    });

    it('should handle high port numbers', async () => {
      const result = await resolveBaseUrl({
        port: 65535,
      });

      expect(result).toBe('http://localhost:65535');
    });
  });

  describe('auto-detection', () => {
    it('should use auto-detected port for SvelteKit default (5173)', async () => {
      const { getWorkflowPort } = await import('@workflow/utils/get-port');
      vi.mocked(getWorkflowPort).mockResolvedValue(5173);
      delete process.env.PORT;

      const result = await resolveBaseUrl({});

      expect(result).toBe('http://localhost:5173');
    });

    it('should use auto-detected port for Vite default (5173)', async () => {
      const { getWorkflowPort } = await import('@workflow/utils/get-port');
      vi.mocked(getWorkflowPort).mockResolvedValue(5173);
      delete process.env.PORT;

      const result = await resolveBaseUrl({});

      expect(result).toBe('http://localhost:5173');
    });

    it('should use auto-detected port for Next.js default (3000)', async () => {
      const { getWorkflowPort } = await import('@workflow/utils/get-port');
      vi.mocked(getWorkflowPort).mockResolvedValue(3000);
      delete process.env.PORT;

      const result = await resolveBaseUrl({});

      expect(result).toBe('http://localhost:3000');
    });

    it('should throw error when auto-detection fails', async () => {
      const { getWorkflowPort } = await import('@workflow/utils/get-port');
      vi.mocked(getWorkflowPort).mockResolvedValue(undefined);
      delete process.env.PORT;

      await expect(resolveBaseUrl({})).rejects.toThrow(
        'Unable to resolve base URL for workflow queue.'
      );
    });
  });

  describe('environment variables', () => {
    it('should use __NEXT_PRIVATE_ORIGIN when no explicit local base URL is set', async () => {
      const { getWorkflowPort } = await import('@workflow/utils/get-port');
      vi.mocked(getWorkflowPort).mockResolvedValue(undefined);
      delete process.env.PORT;
      process.env.__NEXT_PRIVATE_ORIGIN = 'http://localhost:3002';

      const result = await resolveBaseUrl({});

      expect(result).toBe('http://localhost:3002');
      expect(getWorkflowPort).not.toHaveBeenCalled();
    });

    it('should prefer WORKFLOW_LOCAL_BASE_URL over __NEXT_PRIVATE_ORIGIN', async () => {
      const { getWorkflowPort } = await import('@workflow/utils/get-port');
      vi.mocked(getWorkflowPort).mockResolvedValue(undefined);
      process.env.WORKFLOW_LOCAL_BASE_URL = 'http://127.0.0.1:4000';
      process.env.__NEXT_PRIVATE_ORIGIN = 'http://localhost:3002';
      delete process.env.PORT;

      const result = await resolveBaseUrl({});

      expect(result).toBe('http://127.0.0.1:4000');
      expect(getWorkflowPort).not.toHaveBeenCalled();
    });

    it('should use PORT env var as fallback', async () => {
      const { getWorkflowPort } = await import('@workflow/utils/get-port');
      vi.mocked(getWorkflowPort).mockResolvedValue(undefined);
      process.env.PORT = '4173';

      const result = await resolveBaseUrl({});

      expect(result).toBe('http://localhost:4173');
      expect(getWorkflowPort).not.toHaveBeenCalled();
    });

    it('should ignore invalid PORT env var values and continue fallback resolution', async () => {
      const { getWorkflowPort } = await import('@workflow/utils/get-port');
      vi.mocked(getWorkflowPort).mockResolvedValue(5173);
      process.env.PORT = '0';

      const result = await resolveBaseUrl({});

      expect(result).toBe('http://localhost:5173');
      expect(getWorkflowPort).toHaveBeenCalled();
    });

    it('should use TURBO_PORT env var when PORT is not set', async () => {
      const { getWorkflowPort } = await import('@workflow/utils/get-port');
      vi.mocked(getWorkflowPort).mockResolvedValue(undefined);
      delete process.env.PORT;
      process.env.TURBO_PORT = '3002';

      const result = await resolveBaseUrl({});

      expect(result).toBe('http://localhost:3002');
      expect(getWorkflowPort).not.toHaveBeenCalled();
    });

    it('should parse --port from npm_lifecycle_script when no direct env port is set', async () => {
      const { getWorkflowPort } = await import('@workflow/utils/get-port');
      vi.mocked(getWorkflowPort).mockResolvedValue(undefined);
      delete process.env.PORT;
      delete process.env.TURBO_PORT;
      process.env.npm_lifecycle_script =
        'MFE_DISABLE_LOCAL_PROXY_REWRITE=1 next dev --port 3002 --turbopack';

      const result = await resolveBaseUrl({});

      expect(result).toBe('http://localhost:3002');
      expect(getWorkflowPort).not.toHaveBeenCalled();
    });

    it('should parse --port= from npm_lifecycle_script', async () => {
      const { getWorkflowPort } = await import('@workflow/utils/get-port');
      vi.mocked(getWorkflowPort).mockResolvedValue(undefined);
      delete process.env.PORT;
      delete process.env.TURBO_PORT;
      process.env.npm_lifecycle_script = 'next dev --port=3010 --turbopack';

      const result = await resolveBaseUrl({});

      expect(result).toBe('http://localhost:3010');
      expect(getWorkflowPort).not.toHaveBeenCalled();
    });

    it('should use the last --port flag from npm_lifecycle_script when multiple are present', async () => {
      const { getWorkflowPort } = await import('@workflow/utils/get-port');
      vi.mocked(getWorkflowPort).mockResolvedValue(undefined);
      delete process.env.PORT;
      delete process.env.TURBO_PORT;
      process.env.npm_lifecycle_script =
        'next dev --port 3002 --turbopack --port 3000';

      const result = await resolveBaseUrl({});

      expect(result).toBe('http://localhost:3000');
      expect(getWorkflowPort).not.toHaveBeenCalled();
    });

    it('should parse -p from npm_lifecycle_script', async () => {
      const { getWorkflowPort } = await import('@workflow/utils/get-port');
      vi.mocked(getWorkflowPort).mockResolvedValue(undefined);
      delete process.env.PORT;
      delete process.env.TURBO_PORT;
      process.env.npm_lifecycle_script = 'next dev -p 4005';

      const result = await resolveBaseUrl({});

      expect(result).toBe('http://localhost:4005');
      expect(getWorkflowPort).not.toHaveBeenCalled();
    });

    it('should parse -p= from npm_lifecycle_script', async () => {
      const { getWorkflowPort } = await import('@workflow/utils/get-port');
      vi.mocked(getWorkflowPort).mockResolvedValue(undefined);
      delete process.env.PORT;
      delete process.env.TURBO_PORT;
      process.env.npm_lifecycle_script = 'next dev -p=4006';

      const result = await resolveBaseUrl({});

      expect(result).toBe('http://localhost:4006');
      expect(getWorkflowPort).not.toHaveBeenCalled();
    });

    it('should use process.argv when env and lifecycle ports are absent', async () => {
      const { getWorkflowPort } = await import('@workflow/utils/get-port');
      vi.mocked(getWorkflowPort).mockResolvedValue(undefined);
      delete process.env.PORT;
      delete process.env.TURBO_PORT;
      delete process.env.npm_lifecycle_script;
      process.argv = ['/usr/local/bin/node', 'next-server', '--port', '4567'];

      const result = await resolveBaseUrl({});

      expect(result).toBe('http://localhost:4567');
      expect(getWorkflowPort).not.toHaveBeenCalled();
    });

    it('should use the last --port flag from process.argv when repeated', async () => {
      const { getWorkflowPort } = await import('@workflow/utils/get-port');
      vi.mocked(getWorkflowPort).mockResolvedValue(undefined);
      delete process.env.PORT;
      delete process.env.TURBO_PORT;
      delete process.env.npm_lifecycle_script;
      process.argv = [
        '/usr/local/bin/node',
        'next-server',
        '--port',
        '3002',
        '--turbopack',
        '--port',
        '3000',
      ];

      const result = await resolveBaseUrl({});

      expect(result).toBe('http://localhost:3000');
      expect(getWorkflowPort).not.toHaveBeenCalled();
    });

    it('should ignore process.argv --port 0 and fall back to auto-detection', async () => {
      const { getWorkflowPort } = await import('@workflow/utils/get-port');
      vi.mocked(getWorkflowPort).mockResolvedValue(4568);
      delete process.env.PORT;
      delete process.env.TURBO_PORT;
      delete process.env.npm_lifecycle_script;
      process.argv = ['/usr/local/bin/node', 'next-server', '--port', '0'];

      const result = await resolveBaseUrl({});

      expect(result).toBe('http://localhost:4568');
      expect(getWorkflowPort).toHaveBeenCalled();
    });

    it('should resolve from process list when dataDir points to a project with a live next dev port', async () => {
      const { getWorkflowPort } = await import('@workflow/utils/get-port');
      vi.mocked(getWorkflowPort).mockResolvedValue(undefined);
      delete process.env.PORT;
      delete process.env.TURBO_PORT;
      delete process.env.npm_lifecycle_script;
      delete process.env.__NEXT_PRIVATE_ORIGIN;
      process.argv = ['/usr/local/bin/node', 'vitest'];

      const projectRoot = await mkdtemp(
        join(os.tmpdir(), 'workflow-config-process-port-')
      );
      await mkdir(join(projectRoot, '.next', 'workflow-data'), {
        recursive: true,
      });

      const simulatedPort = 41234;
      const helper = spawn(
        process.execPath,
        [
          '-e',
          'setInterval(() => {}, 1000)',
          'next',
          'dev',
          '--port',
          String(simulatedPort),
          `${projectRoot}/app`,
        ],
        { stdio: 'ignore' }
      );

      try {
        await new Promise((resolve) => setTimeout(resolve, 50));
        const result = await resolveBaseUrl({
          dataDir: join(projectRoot, '.next', 'workflow-data'),
        });
        expect(result).toBe(`http://localhost:${simulatedPort}`);
        expect(getWorkflowPort).not.toHaveBeenCalled();
      } finally {
        helper.kill();
        await new Promise((resolve) => helper.once('exit', resolve));
      }
    });

    it('should prefer the newest matching next dev process when multiple ports exist', async () => {
      const { getWorkflowPort } = await import('@workflow/utils/get-port');
      vi.mocked(getWorkflowPort).mockResolvedValue(undefined);
      delete process.env.PORT;
      delete process.env.TURBO_PORT;
      delete process.env.npm_lifecycle_script;
      delete process.env.__NEXT_PRIVATE_ORIGIN;
      process.argv = ['/usr/local/bin/node', 'vitest'];

      const projectRoot = await mkdtemp(
        join(os.tmpdir(), 'workflow-config-process-port-multi-')
      );
      await mkdir(join(projectRoot, '.next', 'workflow-data'), {
        recursive: true,
      });

      const olderPort = 41231;
      const newerPort = 41232;
      const olderHelper = spawn(
        process.execPath,
        [
          '-e',
          'setInterval(() => {}, 1000)',
          'next',
          'dev',
          '--port',
          String(olderPort),
          `${projectRoot}/app`,
        ],
        { stdio: 'ignore' }
      );

      // Ensure PID ordering so the second helper is considered newer.
      await new Promise((resolve) => setTimeout(resolve, 20));

      const newerHelper = spawn(
        process.execPath,
        [
          '-e',
          'setInterval(() => {}, 1000)',
          'next',
          'dev',
          '--port',
          String(newerPort),
          `${projectRoot}/app`,
        ],
        { stdio: 'ignore' }
      );

      try {
        await new Promise((resolve) => setTimeout(resolve, 50));
        const result = await resolveBaseUrl({
          dataDir: join(projectRoot, '.next', 'workflow-data'),
        });
        expect(result).toBe(`http://localhost:${newerPort}`);
        expect(getWorkflowPort).not.toHaveBeenCalled();
      } finally {
        olderHelper.kill();
        newerHelper.kill();
        await Promise.all([
          new Promise((resolve) => olderHelper.once('exit', resolve)),
          new Promise((resolve) => newerHelper.once('exit', resolve)),
        ]);
      }
    });

    it('should ignore PORT env var when config.port is provided', async () => {
      const { getWorkflowPort } = await import('@workflow/utils/get-port');
      process.env.PORT = '4173';

      const result = await resolveBaseUrl({
        port: 5000,
      });

      expect(result).toBe('http://localhost:5000');
      expect(getWorkflowPort).not.toHaveBeenCalled();
    });

    it('should ignore PORT env var when config.baseUrl is provided', async () => {
      const { getWorkflowPort } = await import('@workflow/utils/get-port');
      process.env.PORT = '4173';

      const result = await resolveBaseUrl({
        baseUrl: 'https://example.com',
      });

      expect(result).toBe('https://example.com');
      expect(getWorkflowPort).not.toHaveBeenCalled();
    });
  });

  describe('edge cases', () => {
    it('should throw error with empty config object when no port is detected', async () => {
      const { getWorkflowPort } = await import('@workflow/utils/get-port');
      vi.mocked(getWorkflowPort).mockResolvedValue(undefined);
      delete process.env.PORT;

      await expect(resolveBaseUrl({})).rejects.toThrow(
        'Unable to resolve base URL for workflow queue.'
      );
    });

    it('should throw error when all resolution methods fail', async () => {
      const { getWorkflowPort } = await import('@workflow/utils/get-port');
      vi.mocked(getWorkflowPort).mockResolvedValue(undefined);
      delete process.env.PORT;

      await expect(resolveBaseUrl({})).rejects.toThrow(
        'Unable to resolve base URL for workflow queue.'
      );
    });

    it('should handle config with only dataDir and use PORT env var', async () => {
      const { getWorkflowPort } = await import('@workflow/utils/get-port');
      vi.mocked(getWorkflowPort).mockResolvedValue(5173);
      process.env.PORT = '4000';

      const result = await resolveBaseUrl({
        dataDir: './custom-data',
      });

      expect(result).toBe('http://localhost:4000');
      expect(getWorkflowPort).not.toHaveBeenCalled();
    });

    it('should skip null port and use PORT env var or auto-detection', async () => {
      const { getWorkflowPort } = await import('@workflow/utils/get-port');
      vi.mocked(getWorkflowPort).mockResolvedValue(5173);
      delete process.env.PORT;

      const result = await resolveBaseUrl({
        port: null as any,
      });

      expect(result).toBe('http://localhost:5173');
      expect(getWorkflowPort).toHaveBeenCalled();
    });

    it('should provide helpful error message when no URL can be resolved', async () => {
      const { getWorkflowPort } = await import('@workflow/utils/get-port');
      vi.mocked(getWorkflowPort).mockResolvedValue(undefined);
      delete process.env.PORT;

      await expect(resolveBaseUrl({})).rejects.toThrow(
        'Unable to resolve base URL for workflow queue.'
      );
    });
  });
});
