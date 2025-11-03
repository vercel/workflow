#!/usr/bin/env node

// Simple wrapper to run the CLI from the bin directory
import('../dist/cli.js')
  .then((module) => {
    // Call the setupDatabase function
    return module.setupDatabase();
  })
  .catch((err) => {
    console.error('Failed to load CLI:', err);
    process.exit(1);
  });
