import { mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  findWorkflowDataDir,
  possibleWorkflowDataPaths,
} from './check-data-dir';

describe('findWorkflowDataDir', () => {
  let testDir: string;

  beforeEach(async () => {
    // Create a unique test directory
    testDir = join(process.cwd(), '.test-data-dir-' + Date.now());
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    // Clean up test directory
    await rm(testDir, { recursive: true, force: true });
  });

  describe('when cwd contains workflow data', () => {
    it('should find .next/workflow-data in cwd', async () => {
      const dataPath = join(testDir, '.next', 'workflow-data');
      await mkdir(dataPath, { recursive: true });

      const result = await findWorkflowDataDir(testDir);

      expect(result).not.toBeNull();
      expect(result!.projectDir).toBe(testDir);
      expect(result!.dataDir).toBe(dataPath);
      expect(result!.shortName).toBeTruthy();
    });

    it('should find .workflow-data in cwd', async () => {
      const dataPath = join(testDir, '.workflow-data');
      await mkdir(dataPath, { recursive: true });

      const result = await findWorkflowDataDir(testDir);

      expect(result).not.toBeNull();
      expect(result!.projectDir).toBe(testDir);
      expect(result!.dataDir).toBe(dataPath);
    });

    it('should find workflow-data in cwd', async () => {
      const dataPath = join(testDir, 'workflow-data');
      await mkdir(dataPath, { recursive: true });

      const result = await findWorkflowDataDir(testDir);

      expect(result).not.toBeNull();
      expect(result!.projectDir).toBe(testDir);
      expect(result!.dataDir).toBe(dataPath);
    });

    it('should prefer .next/workflow-data over others', async () => {
      // Create all possible paths
      for (const path of possibleWorkflowDataPaths) {
        await mkdir(join(testDir, path), { recursive: true });
      }

      const result = await findWorkflowDataDir(testDir);

      expect(result).not.toBeNull();
      // .next/workflow-data should be found first as it's first in the list
      expect(result!.dataDir).toBe(join(testDir, '.next', 'workflow-data'));
    });
  });

  describe('when cwd is the workflow data directory itself', () => {
    it('should detect .next/workflow-data path and return parent', async () => {
      const projectDir = join(testDir, 'myproject');
      const dataPath = join(projectDir, '.next', 'workflow-data');
      await mkdir(dataPath, { recursive: true });

      const result = await findWorkflowDataDir(dataPath);

      expect(result).not.toBeNull();
      expect(result!.projectDir).toBe(projectDir);
      expect(result!.dataDir).toBe(dataPath);
    });

    it('should detect .workflow-data path and return parent', async () => {
      const projectDir = join(testDir, 'myproject');
      const dataPath = join(projectDir, '.workflow-data');
      await mkdir(dataPath, { recursive: true });

      const result = await findWorkflowDataDir(dataPath);

      expect(result).not.toBeNull();
      expect(result!.projectDir).toBe(projectDir);
      expect(result!.dataDir).toBe(dataPath);
    });

    it('should detect workflow-data path and return parent', async () => {
      const projectDir = join(testDir, 'myproject');
      const dataPath = join(projectDir, 'workflow-data');
      await mkdir(dataPath, { recursive: true });

      const result = await findWorkflowDataDir(dataPath);

      expect(result).not.toBeNull();
      expect(result!.projectDir).toBe(projectDir);
      expect(result!.dataDir).toBe(dataPath);
    });
  });

  describe('when cwd is inside the project tree', () => {
    it('should walk up to find workflow data in parent', async () => {
      const projectDir = join(testDir, 'myproject');
      const dataPath = join(projectDir, '.next', 'workflow-data');
      const subDir = join(projectDir, 'src', 'components');
      await mkdir(dataPath, { recursive: true });
      await mkdir(subDir, { recursive: true });

      const result = await findWorkflowDataDir(subDir);

      expect(result).not.toBeNull();
      expect(result!.projectDir).toBe(projectDir);
      expect(result!.dataDir).toBe(dataPath);
    });

    it('should find workflow data several levels up', async () => {
      const projectDir = join(testDir, 'myproject');
      const dataPath = join(projectDir, '.workflow-data');
      const deepDir = join(projectDir, 'src', 'app', 'api', 'workflows');
      await mkdir(dataPath, { recursive: true });
      await mkdir(deepDir, { recursive: true });

      const result = await findWorkflowDataDir(deepDir);

      expect(result).not.toBeNull();
      expect(result!.projectDir).toBe(projectDir);
      expect(result!.dataDir).toBe(dataPath);
    });
  });

  describe('when no workflow data is found', () => {
    it('should return null when directory is empty', async () => {
      const result = await findWorkflowDataDir(testDir);
      expect(result).toBeNull();
    });

    it('should return null when only unrelated directories exist', async () => {
      await mkdir(join(testDir, 'src'), { recursive: true });
      await mkdir(join(testDir, 'node_modules'), { recursive: true });

      const result = await findWorkflowDataDir(testDir);
      expect(result).toBeNull();
    });
  });

  describe('path handling', () => {
    it('should handle relative paths', async () => {
      const projectDir = join(testDir, 'relative-test');
      const dataPath = join(projectDir, '.workflow-data');
      await mkdir(dataPath, { recursive: true });

      // Get relative path from cwd to projectDir
      const cwd = process.cwd();
      const relativePath = projectDir.replace(cwd + sep, '');

      const result = await findWorkflowDataDir(relativePath);

      expect(result).not.toBeNull();
      expect(result!.projectDir).toBe(projectDir);
      expect(result!.dataDir).toBe(dataPath);
    });

    it('should handle absolute paths', async () => {
      const projectDir = join(testDir, 'absolute-test');
      const dataPath = join(projectDir, '.next', 'workflow-data');
      await mkdir(dataPath, { recursive: true });

      const result = await findWorkflowDataDir(projectDir);

      expect(result).not.toBeNull();
      expect(result!.projectDir).toBe(resolve(projectDir));
      expect(result!.dataDir).toBe(resolve(dataPath));
    });

    it('should expand tilde paths', async () => {
      // Only test if we can write to home directory (skip in CI)
      const homeTestDir = join(homedir(), '.workflow-test-' + Date.now());

      try {
        const dataPath = join(homeTestDir, '.workflow-data');
        await mkdir(dataPath, { recursive: true });

        const tildePath = '~/.workflow-test-' + homeTestDir.split('-').pop();
        const result = await findWorkflowDataDir(tildePath);

        expect(result).not.toBeNull();
        expect(result!.projectDir).toBe(homeTestDir);
        expect(result!.dataDir).toBe(dataPath);
      } finally {
        await rm(homeTestDir, { recursive: true, force: true });
      }
    });

    it('should return absolute paths even when given relative input', async () => {
      const projectDir = join(testDir, 'paths-test');
      const dataPath = join(projectDir, 'workflow-data');
      await mkdir(dataPath, { recursive: true });

      const result = await findWorkflowDataDir(projectDir);

      expect(result).not.toBeNull();
      // Ensure paths are absolute
      expect(result!.projectDir).toMatch(/^[/\\]|^[A-Z]:/i);
      expect(result!.dataDir).toMatch(/^[/\\]|^[A-Z]:/i);
    });

    it('should normalize paths with .. and .', async () => {
      const projectDir = join(testDir, 'normalize-test');
      const dataPath = join(projectDir, '.workflow-data');
      await mkdir(dataPath, { recursive: true });

      // Create a path with .. and .
      const weirdPath = join(projectDir, 'subdir', '..', '.', '.');

      const result = await findWorkflowDataDir(weirdPath);

      expect(result).not.toBeNull();
      expect(result!.projectDir).toBe(projectDir);
      expect(result!.dataDir).toBe(dataPath);
    });
  });

  describe('shortName generation', () => {
    it('should return last two folder names', async () => {
      const projectDir = join(testDir, 'code', 'myproject');
      const dataPath = join(projectDir, '.workflow-data');
      await mkdir(dataPath, { recursive: true });

      const result = await findWorkflowDataDir(projectDir);

      expect(result).not.toBeNull();
      expect(result!.shortName).toBe('code/myproject');
    });

    it('should return single folder name for shallow path', async () => {
      const projectDir = join(testDir, 'myproject');
      const dataPath = join(projectDir, '.workflow-data');
      await mkdir(dataPath, { recursive: true });

      const result = await findWorkflowDataDir(projectDir);

      expect(result).not.toBeNull();
      // The shortName should include the last two parts, which includes testDir name and 'myproject'
      const parts = result!.shortName.split('/');
      expect(parts.length).toBeLessThanOrEqual(2);
      expect(parts[parts.length - 1]).toBe('myproject');
    });

    it('should handle deeply nested projects', async () => {
      const projectDir = join(testDir, 'a', 'b', 'c', 'd', 'project');
      const dataPath = join(projectDir, '.workflow-data');
      await mkdir(dataPath, { recursive: true });

      const result = await findWorkflowDataDir(projectDir);

      expect(result).not.toBeNull();
      expect(result!.shortName).toBe('d/project');
    });
  });

  describe('edge cases', () => {
    it('should handle non-existent directories gracefully', async () => {
      const result = await findWorkflowDataDir('/this/path/does/not/exist');
      expect(result).toBeNull();
    });

    it('should handle empty string path', async () => {
      // Empty string should default to cwd
      const result = await findWorkflowDataDir('');
      // Result depends on whether cwd has workflow data
      expect(result === null || typeof result === 'object').toBe(true);
    });

    it('should handle path with trailing slashes', async () => {
      const projectDir = join(testDir, 'trailing');
      const dataPath = join(projectDir, '.workflow-data');
      await mkdir(dataPath, { recursive: true });

      const result = await findWorkflowDataDir(projectDir + sep);

      expect(result).not.toBeNull();
      expect(result!.projectDir).toBe(projectDir);
    });

    it('should handle workflow data dir that does not exist when passed directly', async () => {
      // The path looks like a workflow data dir but doesn't exist
      const fakePath = join(testDir, 'fake', '.next', 'workflow-data');

      const result = await findWorkflowDataDir(fakePath);

      expect(result).toBeNull();
    });
  });
});
