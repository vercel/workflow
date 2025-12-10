import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveBaseUrl } from './config';

// Mock the getWorkflowPort function from @workflow/utils/get-port
vi.mock('@workflow/utils/get-port', () => ({
  getWorkflowPort: vi.fn(),
}));

describe('resolveBaseUrl', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
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

    it('should handle port 0 (OS-assigned port)', async () => {
      const { getWorkflowPort } = await import('@workflow/utils/get-port');

      const result = await resolveBaseUrl({
        port: 0,
      });

      expect(result).toBe('http://localhost:0');
      expect(getWorkflowPort).not.toHaveBeenCalled();
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
    it('should use PORT env var as fallback', async () => {
      const { getWorkflowPort } = await import('@workflow/utils/get-port');
      vi.mocked(getWorkflowPort).mockResolvedValue(undefined);
      process.env.PORT = '4173';

      const result = await resolveBaseUrl({});

      expect(result).toBe('http://localhost:4173');
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
