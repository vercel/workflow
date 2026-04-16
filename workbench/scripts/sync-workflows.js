#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

function copyDirContents(sourceDir, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });

  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      copyDirContents(sourcePath, targetPath);
      continue;
    }

    if (entry.isSymbolicLink()) {
      const realSourcePath = fs.realpathSync(sourcePath);
      const realStats = fs.statSync(realSourcePath);

      if (realStats.isDirectory()) {
        copyDirContents(realSourcePath, targetPath);
      } else {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.copyFileSync(realSourcePath, targetPath);
      }
      continue;
    }

    if (entry.isFile()) {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.copyFileSync(sourcePath, targetPath);
    }
  }
}

function removeDir(targetDir) {
  fs.rmSync(targetDir, { recursive: true, force: true });
}

function main() {
  const args = process.argv.slice(2);
  const sourceDir = args[0] || './workflows';
  const targetDir = args[1] || './.generated/workflows';

  if (!fs.existsSync(sourceDir)) {
    console.error(`Error: Workflows directory not found: ${sourceDir}`);
    process.exit(1);
  }

  removeDir(targetDir);
  copyDirContents(sourceDir, targetDir);

  console.log(`✓ Synced workflows to ${targetDir}`);
}

try {
  main();
} catch (error) {
  console.error('Error syncing workflows:', error);
  process.exit(1);
}
