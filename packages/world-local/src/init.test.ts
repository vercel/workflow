import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DataDirAccessError,
  DataDirVersionError,
  ensureDataDir,
  formatVersion,
  formatVersionFile,
  initDataDir,
  type ParsedVersion,
  parseVersion,
  parseVersionFile,
  upgradeVersion,
} from './init.js';

describe('parseVersion', () => {
  it('should parse a simple version string', () => {
    const result = parseVersion('1.2.3');
    expect(result).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: undefined,
      raw: '1.2.3',
    });
  });

  it('should parse a version with prerelease tag', () => {
    const result = parseVersion('4.0.1-beta.20');
    expect(result).toEqual({
      major: 4,
      minor: 0,
      patch: 1,
      prerelease: 'beta.20',
      raw: '4.0.1-beta.20',
    });
  });

  it('should parse a version with alpha prerelease', () => {
    const result = parseVersion('2.0.0-alpha.1');
    expect(result).toEqual({
      major: 2,
      minor: 0,
      patch: 0,
      prerelease: 'alpha.1',
      raw: '2.0.0-alpha.1',
    });
  });

  it('should throw for invalid version strings', () => {
    expect(() => parseVersion('invalid')).toThrow('Invalid version string');
    expect(() => parseVersion('1.2')).toThrow('Invalid version string');
    expect(() => parseVersion('1.2.3.4')).toThrow('Invalid version string');
    expect(() => parseVersion('')).toThrow('Invalid version string');
  });
});

describe('formatVersion', () => {
  it('should format a simple version', () => {
    const version: ParsedVersion = {
      major: 1,
      minor: 2,
      patch: 3,
      raw: '1.2.3',
    };
    expect(formatVersion(version)).toBe('1.2.3');
  });

  it('should format a version with prerelease', () => {
    const version: ParsedVersion = {
      major: 4,
      minor: 0,
      patch: 1,
      prerelease: 'beta.20',
      raw: '4.0.1-beta.20',
    };
    expect(formatVersion(version)).toBe('4.0.1-beta.20');
  });
});

describe('parseVersionFile', () => {
  it('should parse a version file content', () => {
    const result = parseVersionFile('@workflow/world-local@4.0.1-beta.20');
    expect(result.packageName).toBe('@workflow/world-local');
    expect(result.version.major).toBe(4);
    expect(result.version.minor).toBe(0);
    expect(result.version.patch).toBe(1);
    expect(result.version.prerelease).toBe('beta.20');
  });

  it('should handle content with whitespace', () => {
    const result = parseVersionFile('  @workflow/world-local@1.0.0  \n');
    expect(result.packageName).toBe('@workflow/world-local');
    expect(result.version.major).toBe(1);
  });

  it('should throw for invalid content', () => {
    expect(() => parseVersionFile('invalid-content')).toThrow(
      'Invalid version file content'
    );
    expect(() => parseVersionFile('')).toThrow('Invalid version file content');
  });
});

describe('formatVersionFile', () => {
  it('should format version file content', () => {
    const version: ParsedVersion = {
      major: 4,
      minor: 0,
      patch: 1,
      prerelease: 'beta.20',
      raw: '4.0.1-beta.20',
    };
    const result = formatVersionFile('@workflow/world-local', version);
    expect(result).toBe('@workflow/world-local@4.0.1-beta.20');
  });
});

describe('upgradeVersion', () => {
  it('should log upgrade message', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const oldVersion = parseVersion('3.0.0');
    const newVersion = parseVersion('4.0.1-beta.20');

    upgradeVersion(oldVersion, newVersion);

    expect(consoleSpy).toHaveBeenCalledWith(
      '[world-local] Upgrading from version 3.0.0 to 4.0.1-beta.20'
    );

    consoleSpy.mockRestore();
  });
});

describe('ensureDataDir', () => {
  let testBaseDir: string;

  beforeEach(() => {
    testBaseDir = path.join(
      tmpdir(),
      `workflow-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(testBaseDir, { recursive: true });
  });

  afterEach(() => {
    try {
      if (existsSync(testBaseDir)) {
        chmodSync(testBaseDir, 0o755);
      }
      rmSync(testBaseDir, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('directory creation', () => {
    it('should create the directory if it does not exist', () => {
      const dataDir = path.join(testBaseDir, 'new-data-dir');
      expect(existsSync(dataDir)).toBe(false);

      ensureDataDir(dataDir);

      expect(existsSync(dataDir)).toBe(true);
    });

    it('should create nested directories recursively', () => {
      const dataDir = path.join(testBaseDir, 'level1', 'level2', 'level3');
      expect(existsSync(dataDir)).toBe(false);

      ensureDataDir(dataDir);

      expect(existsSync(dataDir)).toBe(true);
    });

    it('should not throw if the directory already exists', () => {
      const dataDir = path.join(testBaseDir, 'existing-dir');
      mkdirSync(dataDir);
      expect(existsSync(dataDir)).toBe(true);

      expect(() => ensureDataDir(dataDir)).not.toThrow();
    });

    it('should handle relative paths by resolving to absolute paths', () => {
      const originalCwd = process.cwd();
      try {
        process.chdir(testBaseDir);
        const relativeDir = 'relative-data-dir';

        ensureDataDir(relativeDir);

        expect(existsSync(path.join(testBaseDir, relativeDir))).toBe(true);
      } finally {
        process.chdir(originalCwd);
      }
    });
  });

  describe('permission errors', () => {
    const isWindows = process.platform === 'win32';

    it.skipIf(isWindows)(
      'should throw DataDirAccessError if directory is not readable',
      () => {
        const dataDir = path.join(testBaseDir, 'unreadable-dir');
        mkdirSync(dataDir);
        chmodSync(dataDir, 0o000);

        try {
          expect(() => ensureDataDir(dataDir)).toThrow(DataDirAccessError);
          expect(() => ensureDataDir(dataDir)).toThrow(/not readable/);
        } finally {
          chmodSync(dataDir, 0o755);
        }
      }
    );

    it.skipIf(isWindows)(
      'should throw DataDirAccessError if directory is not writable',
      () => {
        const dataDir = path.join(testBaseDir, 'readonly-dir');
        mkdirSync(dataDir);
        chmodSync(dataDir, 0o555);

        try {
          expect(() => ensureDataDir(dataDir)).toThrow(DataDirAccessError);
          expect(() => ensureDataDir(dataDir)).toThrow(/not writable/);
        } finally {
          chmodSync(dataDir, 0o755);
        }
      }
    );

    it.skipIf(isWindows)(
      'should throw DataDirAccessError if parent directory is not writable',
      () => {
        const parentDir = path.join(testBaseDir, 'readonly-parent');
        mkdirSync(parentDir);
        chmodSync(parentDir, 0o555);

        const dataDir = path.join(parentDir, 'new-child-dir');

        try {
          expect(() => ensureDataDir(dataDir)).toThrow(DataDirAccessError);
          expect(() => ensureDataDir(dataDir)).toThrow(
            /Failed to create data directory/
          );
        } finally {
          chmodSync(parentDir, 0o755);
        }
      }
    );
  });

  describe('DataDirAccessError', () => {
    it('should include the data directory path in the error', () => {
      const dataDir = path.join(testBaseDir, 'readonly-parent-for-error');
      const isWindows = process.platform === 'win32';

      if (!isWindows) {
        mkdirSync(dataDir);
        chmodSync(dataDir, 0o555);

        const childDir = path.join(dataDir, 'child');

        try {
          ensureDataDir(childDir);
        } catch (error) {
          expect(error).toBeInstanceOf(DataDirAccessError);
          expect((error as DataDirAccessError).dataDir).toBe(childDir);
        } finally {
          chmodSync(dataDir, 0o755);
        }
      }
    });

    it('should include the error code when available', () => {
      const isWindows = process.platform === 'win32';

      if (!isWindows) {
        const parentDir = path.join(testBaseDir, 'readonly-parent-for-code');
        mkdirSync(parentDir);
        chmodSync(parentDir, 0o555);

        const dataDir = path.join(parentDir, 'child');

        try {
          ensureDataDir(dataDir);
        } catch (error) {
          expect(error).toBeInstanceOf(DataDirAccessError);
          expect((error as DataDirAccessError).code).toBeDefined();
        } finally {
          chmodSync(parentDir, 0o755);
        }
      }
    });
  });

  describe('edge cases', () => {
    it('should handle empty string by creating directory at current path', () => {
      const originalCwd = process.cwd();
      try {
        process.chdir(testBaseDir);
        expect(() => ensureDataDir('.')).not.toThrow();
      } finally {
        process.chdir(originalCwd);
      }
    });

    it('should handle paths with special characters', () => {
      const dataDir = path.join(testBaseDir, 'special-chars-dir-@#$%');

      ensureDataDir(dataDir);

      expect(existsSync(dataDir)).toBe(true);
    });

    it('should handle paths with spaces', () => {
      const dataDir = path.join(testBaseDir, 'dir with spaces');

      ensureDataDir(dataDir);

      expect(existsSync(dataDir)).toBe(true);
    });
  });
});

describe('initDataDir', () => {
  let testBaseDir: string;

  beforeEach(() => {
    testBaseDir = path.join(
      tmpdir(),
      `workflow-init-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(testBaseDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(testBaseDir, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
    vi.restoreAllMocks();
  });

  it('should create version.txt for new data directory', () => {
    const dataDir = path.join(testBaseDir, 'new-data');

    initDataDir(dataDir);

    const versionPath = path.join(dataDir, 'version.txt');
    expect(existsSync(versionPath)).toBe(true);

    const content = readFileSync(versionPath, 'utf-8');
    expect(content).toMatch(/^@workflow\/world-local@\d+\.\d+\.\d+/);
  });

  it('should not modify version.txt if version matches', () => {
    const dataDir = path.join(testBaseDir, 'existing-data');
    mkdirSync(dataDir, { recursive: true });

    // Write the current version
    const versionPath = path.join(dataDir, 'version.txt');
    writeFileSync(versionPath, '@workflow/world-local@4.0.1-beta.20');

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    initDataDir(dataDir);

    // Should not log upgrade message since versions match
    expect(consoleSpy).not.toHaveBeenCalled();

    // File should remain unchanged
    const content = readFileSync(versionPath, 'utf-8');
    expect(content).toBe('@workflow/world-local@4.0.1-beta.20');
  });

  it('should call upgradeVersion when versions differ', () => {
    const dataDir = path.join(testBaseDir, 'old-data');
    mkdirSync(dataDir, { recursive: true });

    // Write an older version
    const versionPath = path.join(dataDir, 'version.txt');
    writeFileSync(versionPath, '@workflow/world-local@3.0.0');

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    initDataDir(dataDir);

    // Should log upgrade message
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Upgrading from version 3.0.0')
    );

    // File should be updated to new version
    const content = readFileSync(versionPath, 'utf-8');
    expect(content).toMatch(/^@workflow\/world-local@4\.0\.1/);
  });

  it('should handle data directory with newer version', () => {
    const dataDir = path.join(testBaseDir, 'newer-data');
    mkdirSync(dataDir, { recursive: true });

    // Write a newer version (simulating downgrade scenario)
    const versionPath = path.join(dataDir, 'version.txt');
    writeFileSync(versionPath, '@workflow/world-local@5.0.0');

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // This will call upgradeVersion which just logs for now
    initDataDir(dataDir);

    // Should log the upgrade message (even for "downgrades")
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Upgrading from version 5.0.0')
    );
  });
});

describe('DataDirVersionError', () => {
  it('should store version information', () => {
    const oldVersion = parseVersion('1.0.0');
    const newVersion = parseVersion('2.0.0');

    const error = new DataDirVersionError(
      'Incompatible',
      oldVersion,
      newVersion,
      '1.5.0'
    );

    expect(error.name).toBe('DataDirVersionError');
    expect(error.oldVersion).toBe(oldVersion);
    expect(error.newVersion).toBe(newVersion);
    expect(error.suggestedVersion).toBe('1.5.0');
    expect(error.message).toBe('Incompatible');
  });

  it('should work without suggested version', () => {
    const oldVersion = parseVersion('1.0.0');
    const newVersion = parseVersion('2.0.0');

    const error = new DataDirVersionError(
      'Incompatible',
      oldVersion,
      newVersion
    );

    expect(error.suggestedVersion).toBeUndefined();
  });
});
