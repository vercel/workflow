import { fileURLToPath } from 'node:url';
import { createTestSuite } from '@workflow/world-testing';

process.env.WORKFLOW_TEST_SQLITE_WORLD = '1';

createTestSuite(fileURLToPath(new URL('../dist/index.js', import.meta.url)));
