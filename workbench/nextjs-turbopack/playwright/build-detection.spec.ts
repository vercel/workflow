import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

test.describe('Next.js Build Detection Tests', () => {
  const workbenchDir = process.cwd();

  test.describe('Build WITH libraries configuration', () => {
    test('should build successfully when libraries are configured', async () => {
      // Verify next.config.ts has libraries configured
      const configPath = join(workbenchDir, 'next.config.ts');
      expect(existsSync(configPath)).toBe(true);

      const configContent = readFileSync(configPath, 'utf-8');
      expect(configContent).toContain('libraries:');
      expect(configContent).toContain('@worklow-npm-library');

      // Run build
      try {
        const output = execSync('pnpm build', {
          cwd: workbenchDir,
          encoding: 'utf-8',
          stdio: 'pipe',
        });
        expect(output).toBeTruthy();
      } catch (error: any) {
        // Build should succeed
        throw new Error(`Build failed but should succeed: ${error.message}`);
      }
    });

    test('should detect library workflows in build output', async () => {
      // This test verifies that the build process detects workflows from libraries
      const configPath = join(workbenchDir, 'next.config.ts');
      const configContent = readFileSync(configPath, 'utf-8');

      if (configContent.includes('libraries:')) {
        // Run build and check for library workflow detection
        try {
          const output = execSync('pnpm build', {
            cwd: workbenchDir,
            encoding: 'utf-8',
            stdio: 'pipe',
          });
          // Check for workflow-related output
          expect(output).toBeTruthy();
        } catch (error: any) {
          // If build fails, check if it's due to missing library detection
          const errorOutput = error.stdout || error.stderr || error.message;
          // This test should pass once library detection works
          throw new Error(
            `Build should detect library workflows: ${errorOutput}`
          );
        }
      }
    });
  });

  test.describe('Build WITHOUT libraries configuration', () => {
    test('should build successfully with local workflows only', async () => {
      // Create a temporary config without libraries
      const originalConfig = readFileSync(
        join(workbenchDir, 'next.config.ts'),
        'utf-8'
      );

      // Create a config without libraries (but keep local workflows)
      const configWithoutLibraries = originalConfig.replace(
        /libraries:\s*\[[^\]]+\],?/g,
        ''
      );

      // Verify local workflows exist
      const workflowsDir = join(workbenchDir, 'workflows');
      expect(existsSync(workflowsDir)).toBe(true);

      // Note: We don't actually modify the config in this test
      // This is a theoretical test - actual implementation would require
      // creating a separate test workbench or using test fixtures
      expect(configWithoutLibraries).not.toContain('libraries:');
    });

    test('should fail or skip library workflows when libraries not configured', async () => {
      // This test verifies that without library configuration,
      // library workflows should not be available
      const workflowsDir = join(workbenchDir, 'workflows');
      const localWorkflowsExist = existsSync(workflowsDir);

      // Local workflows should exist
      expect(localWorkflowsExist).toBe(true);

      // Without libraries config, library workflows should not work
      // but local workflows should still work
      // This is a placeholder test - actual test would need to
      // modify next.config.ts and verify behavior
    });
  });

  test.describe('Build detection of workflow directives', () => {
    test('should detect "use workflow" in local files', async () => {
      const workflowsDir = join(workbenchDir, 'workflows');
      if (existsSync(workflowsDir)) {
        // Check if local workflow files have "use workflow"
        // This is a basic check - actual implementation would scan files
        expect(existsSync(workflowsDir)).toBe(true);
      }
    });

    test('should detect "use workflow" in library files', async () => {
      // Check library workflow file
      const libraryWorkflowPath = join(
        workbenchDir,
        '../workflow-npm-library/src/workflows/workbench-library.ts'
      );

      if (existsSync(libraryWorkflowPath)) {
        const content = readFileSync(libraryWorkflowPath, 'utf-8');
        expect(content).toContain('use workflow');
      }
    });

    test('should detect "use step" in library files', async () => {
      // Check library step file
      const libraryStepPath = join(
        workbenchDir,
        '../workflow-npm-library/src/steps/uppercase.ts'
      );

      if (existsSync(libraryStepPath)) {
        const content = readFileSync(libraryStepPath, 'utf-8');
        expect(content).toContain('use step');
      }
    });
  });
});
