import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveBaseUrl } from './config';

// Mock the getPort function from @workflow/utils/node
vi.mock('@workflow/utils/node', () => ({
  getPort: vi.fn(),
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
      const { getPort } = await import('@workflow/utils/node');
      vi.mocked(getPort).mockResolvedValue(5173);
      process.env.PORT = '8080';

      const result = await resolveBaseUrl({
        baseUrl: 'https://custom.example.com:3000',
        port: 4000,
      });

      expect(result).toBe('https://custom.example.com:3000');
      expect(getPort).not.toHaveBeenCalled();
    });

    it('should use config.port when baseUrl is not provided', async () => {
      const { getPort } = await import('@workflow/utils/node');
      vi.mocked(getPort).mockResolvedValue(5173);
      process.env.PORT = '8080';

      const result = await resolveBaseUrl({
        port: 4000,
      });

      expect(result).toBe('http://localhost:4000');
      expect(getPort).not.toHaveBeenCalled();
    });

    it('should auto-detect port when neither baseUrl nor port is provided', async () => {
      const { getPort } = await import('@workflow/utils/node');
      vi.mocked(getPort).mockResolvedValue(5173);
      process.env.PORT = '8080';

      const result = await resolveBaseUrl({});

      expect(result).toBe('http://localhost:5173');
      expect(getPort).toHaveBeenCalled();
    });

    it('should use PORT env var when auto-detection returns undefined', async () => {
      const { getPort } = await import('@workflow/utils/node');
      vi.mocked(getPort).mockResolvedValue(undefined);
      process.env.PORT = '8080';

      const result = await resolveBaseUrl({});

      expect(result).toBe('http://localhost:8080');
      expect(getPort).toHaveBeenCalled();
    });

    it('should fallback to 3000 when all detection methods fail', async () => {
      const { getPort } = await import('@workflow/utils/node');
      vi.mocked(getPort).mockResolvedValue(undefined);
      delete process.env.PORT;

      const result = await resolveBaseUrl({});

      expect(result).toBe('http://localhost:3000');
      expect(getPort).toHaveBeenCalled();
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
      const { getPort } = await import('@workflow/utils/node');
      vi.mocked(getPort).mockResolvedValue(5173);

      const result = await resolveBaseUrl({});

      expect(result).toBe('http://localhost:5173');
    });

    it('should use auto-detected port for Vite default (5173)', async () => {
      const { getPort } = await import('@workflow/utils/node');
      vi.mocked(getPort).mockResolvedValue(5173);

      const result = await resolveBaseUrl({});

      expect(result).toBe('http://localhost:5173');
    });

    it('should use auto-detected port for Next.js default (3000)', async () => {
      const { getPort } = await import('@workflow/utils/node');
      vi.mocked(getPort).mockResolvedValue(3000);

      const result = await resolveBaseUrl({});

      expect(result).toBe('http://localhost:3000');
    });

    it('should handle auto-detection failure gracefully', async () => {
      const { getPort } = await import('@workflow/utils/node');
      vi.mocked(getPort).mockResolvedValue(undefined);
      delete process.env.PORT;

      const result = await resolveBaseUrl({});

      expect(result).toBe('http://localhost:3000');
    });
  });

  describe('environment variables', () => {
    it('should use PORT env var as fallback', async () => {
      const { getPort } = await import('@workflow/utils/node');
      vi.mocked(getPort).mockResolvedValue(undefined);
      process.env.PORT = '4173';

      const result = await resolveBaseUrl({});

      expect(result).toBe('http://localhost:4173');
    });

    it('should ignore PORT env var when config.port is provided', async () => {
      const { getPort } = await import('@workflow/utils/node');
      process.env.PORT = '4173';

      const result = await resolveBaseUrl({
        port: 5000,
      });

      expect(result).toBe('http://localhost:5000');
      expect(getPort).not.toHaveBeenCalled();
    });

    it('should ignore PORT env var when config.baseUrl is provided', async () => {
      const { getPort } = await import('@workflow/utils/node');
      process.env.PORT = '4173';

      const result = await resolveBaseUrl({
        baseUrl: 'https://example.com',
      });

      expect(result).toBe('https://example.com');
      expect(getPort).not.toHaveBeenCalled();
    });
  });

  describe('edge cases', () => {
    it('should handle empty config object', async () => {
      const { getPort } = await import('@workflow/utils/node');
      vi.mocked(getPort).mockResolvedValue(undefined);
      delete process.env.PORT;

      const result = await resolveBaseUrl({});

      expect(result).toBe('http://localhost:3000');
    });

    it('should handle undefined config', async () => {
      const { getPort } = await import('@workflow/utils/node');
      vi.mocked(getPort).mockResolvedValue(undefined);
      delete process.env.PORT;

      const result = await resolveBaseUrl({});

      expect(result).toBe('http://localhost:3000');
    });

    it('should handle config with only dataDir', async () => {
      const { getPort } = await import('@workflow/utils/node');
      vi.mocked(getPort).mockResolvedValue(5173);

      const result = await resolveBaseUrl({
        dataDir: './custom-data',
      });

      expect(result).toBe('http://localhost:5173');
    });
  });
});
