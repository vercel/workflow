import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const workbenchRoot = path.join(repoRoot, 'workbench');
const workbenchScriptsRoot = path.join(workbenchRoot, 'scripts');
const repoLibRoot = path.join(repoRoot, 'lib');
const packagesRoot = path.join(repoRoot, 'packages');
const workspaceYamlPath = path.join(repoRoot, 'pnpm-workspace.yaml');

const dependencyFields = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
];

const excludedPaths = new Set([
  'node_modules',
  '.next',
  '.turbo',
  '.vercel',
  '.output',
  '.nitro',
  'dist',
]);

function run(command, args, cwd) {
  console.log(`$ ${command} ${args.join(' ')}`);
  execFileSync(command, args, {
    cwd,
    stdio: 'inherit',
    env: {
      ...process.env,
      COREPACK_ENABLE_AUTO_PIN: process.env.COREPACK_ENABLE_AUTO_PIN ?? '0',
    },
  });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function usage() {
  console.error(
    'Usage: node scripts/stage-workbench-with-tarballs.mjs <workbench-name-or-path>'
  );
}

function resolveWorkbenchDir(inputArg) {
  const candidates = [
    path.resolve(repoRoot, inputArg),
    path.resolve(workbenchRoot, inputArg),
  ];

  for (const candidate of candidates) {
    const packageJsonPath = path.join(candidate, 'package.json');
    if (fs.existsSync(candidate) && fs.existsSync(packageJsonPath)) {
      return candidate;
    }
  }

  throw new Error(
    `Could not resolve workbench "${inputArg}". Expected either workbench/<name> or a path containing package.json.`
  );
}

function toTarballFilename(packageName, version) {
  const normalized = packageName.replace(/^@/, '').replace(/\//g, '-');
  return `${normalized}-${version}.tgz`;
}

function parseCatalogEntries(yamlPath) {
  const catalog = {};
  const lines = fs.readFileSync(yamlPath, 'utf8').split(/\r?\n/u);
  let inCatalog = false;

  for (const line of lines) {
    if (!inCatalog) {
      if (line.trim() === 'catalog:') {
        inCatalog = true;
      }
      continue;
    }

    if (!line.trim()) {
      continue;
    }

    if (!line.startsWith('  ')) {
      break;
    }

    const match = line.match(/^\s{2}("?[^"]+"?|[^:]+):\s*(.+)\s*$/u);
    if (!match) {
      continue;
    }

    let key = match[1].trim();
    if (key.startsWith('"') && key.endsWith('"')) {
      key = key.slice(1, -1);
    }
    const value = match[2].trim();
    catalog[key] = value;
  }

  return catalog;
}

function collectMonorepoPackages() {
  const tarballByPackageName = new Map();
  const dirs = fs.readdirSync(packagesRoot, { withFileTypes: true });

  for (const dirent of dirs) {
    if (!dirent.isDirectory()) {
      continue;
    }

    const packageDir = path.join(packagesRoot, dirent.name);
    const packageJsonPath = path.join(packageDir, 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
      continue;
    }

    const packageJson = readJson(packageJsonPath);
    tarballByPackageName.set(
      packageJson.name,
      toTarballFilename(packageJson.name, packageJson.version)
    );
  }

  return tarballByPackageName;
}

function copyWorkbenchWithResolvedSymlinks(sourceDir, destinationDir) {
  fs.cpSync(sourceDir, destinationDir, {
    recursive: true,
    dereference: true,
    filter: (sourcePath) => {
      const baseName = path.basename(sourcePath);
      return !excludedPaths.has(baseName);
    },
  });
}

function copyWorkbenchScripts(destinationRoot) {
  if (!fs.existsSync(workbenchScriptsRoot)) {
    return false;
  }

  const destinationScriptsDir = path.join(destinationRoot, 'scripts');
  fs.cpSync(workbenchScriptsRoot, destinationScriptsDir, {
    recursive: true,
    dereference: true,
    filter: (sourcePath) => {
      const baseName = path.basename(sourcePath);
      return !excludedPaths.has(baseName);
    },
  });
  return true;
}

function copyRepoLib(destinationRoot) {
  if (!fs.existsSync(repoLibRoot)) {
    return false;
  }

  const destinationLibDir = path.join(destinationRoot, 'lib');
  fs.cpSync(repoLibRoot, destinationLibDir, {
    recursive: true,
    dereference: true,
    filter: (sourcePath) => {
      const baseName = path.basename(sourcePath);
      return !excludedPaths.has(baseName);
    },
  });
  return true;
}

function rewriteDependencySpecs(
  packageJsonPath,
  tarballPathByPackageName,
  catalog
) {
  const packageJson = readJson(packageJsonPath);
  const replacedWithTarballs = [];
  const replacedCatalogEntries = [];
  const unresolvedWorkspaceSpecs = [];
  const unresolvedCatalogSpecs = [];

  for (const field of dependencyFields) {
    const dependencies = packageJson[field];
    if (!dependencies) {
      continue;
    }

    for (const [dependencyName, spec] of Object.entries(dependencies)) {
      const tarballPath = tarballPathByPackageName.get(dependencyName);
      if (tarballPath) {
        dependencies[dependencyName] = `file:${tarballPath}`;
        replacedWithTarballs.push(`${field}.${dependencyName}`);
        continue;
      }

      if (typeof spec === 'string' && spec.startsWith('workspace:')) {
        unresolvedWorkspaceSpecs.push(`${field}.${dependencyName}`);
        continue;
      }

      if (spec === 'catalog:') {
        const resolvedVersion = catalog[dependencyName];
        if (resolvedVersion) {
          dependencies[dependencyName] = resolvedVersion;
          replacedCatalogEntries.push(`${field}.${dependencyName}`);
        } else {
          unresolvedCatalogSpecs.push(`${field}.${dependencyName}`);
        }
        continue;
      }

      if (typeof spec === 'string' && spec.startsWith('catalog:')) {
        unresolvedCatalogSpecs.push(`${field}.${dependencyName}`);
      }
    }
  }

  if (unresolvedWorkspaceSpecs.length > 0) {
    throw new Error(
      `Found unresolved workspace dependencies in staged workbench package.json: ${unresolvedWorkspaceSpecs.join(', ')}`
    );
  }

  if (unresolvedCatalogSpecs.length > 0) {
    throw new Error(
      `Found unresolved catalog dependencies in staged workbench package.json: ${unresolvedCatalogSpecs.join(', ')}`
    );
  }

  writeJson(packageJsonPath, packageJson);
  return { replacedWithTarballs, replacedCatalogEntries };
}

function applyTarballOverrides(packageJsonPath, tarballPathByPackageName) {
  const packageJson = readJson(packageJsonPath);
  const pnpmConfig =
    packageJson.pnpm && typeof packageJson.pnpm === 'object'
      ? packageJson.pnpm
      : {};
  const overrides =
    pnpmConfig.overrides && typeof pnpmConfig.overrides === 'object'
      ? pnpmConfig.overrides
      : {};

  let overridesApplied = 0;
  for (const [packageName, tarballPath] of tarballPathByPackageName.entries()) {
    overrides[packageName] = `file:${tarballPath}`;
    overridesApplied += 1;
  }

  packageJson.pnpm = {
    ...pnpmConfig,
    overrides,
  };

  writeJson(packageJsonPath, packageJson);
  return overridesApplied;
}

function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  const [workbenchArg] = args;
  if (!workbenchArg) {
    usage();
    process.exit(1);
  }

  const sourceWorkbenchDir = resolveWorkbenchDir(workbenchArg);
  const workbenchName = path.basename(sourceWorkbenchDir);

  const tmpRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), `workflow-${workbenchName}-`)
  );
  const stagedWorkbenchRoot = path.join(tmpRoot, 'workbench');
  const stagedWorkbenchDir = path.join(stagedWorkbenchRoot, workbenchName);
  const tarballDir = path.join(tmpRoot, 'tarballs');
  fs.mkdirSync(stagedWorkbenchRoot, { recursive: true });
  fs.mkdirSync(tarballDir, { recursive: true });

  console.log(
    `Staging ${path.relative(repoRoot, sourceWorkbenchDir)} at ${stagedWorkbenchDir}`
  );
  copyWorkbenchWithResolvedSymlinks(sourceWorkbenchDir, stagedWorkbenchDir);
  const copiedScripts = copyWorkbenchScripts(stagedWorkbenchRoot);
  if (copiedScripts) {
    console.log(
      `Copied workbench scripts to ${path.join(stagedWorkbenchRoot, 'scripts')}`
    );
  }

  const copiedLib = copyRepoLib(tmpRoot);
  if (copiedLib) {
    console.log(`Copied repo lib to ${path.join(tmpRoot, 'lib')}`);
  }

  console.log(`Packing monorepo packages to ${tarballDir}`);
  run(
    'pnpm',
    [
      '-r',
      '--filter',
      './packages/*',
      'pack',
      '--pack-destination',
      tarballDir,
    ],
    repoRoot
  );

  const tarballFileByPackageName = collectMonorepoPackages();
  const tarballPathByPackageName = new Map();
  const missingTarballs = [];

  for (const [packageName, tarballFile] of tarballFileByPackageName.entries()) {
    const tarballPath = path.join(tarballDir, tarballFile);
    if (!fs.existsSync(tarballPath)) {
      missingTarballs.push(`${packageName} (${tarballFile})`);
      continue;
    }
    tarballPathByPackageName.set(packageName, tarballPath);
  }

  if (missingTarballs.length > 0) {
    throw new Error(
      `Missing tarballs after packing: ${missingTarballs.join(', ')}`
    );
  }

  const catalog = parseCatalogEntries(workspaceYamlPath);
  const stagedPackageJsonPath = path.join(stagedWorkbenchDir, 'package.json');
  const { replacedWithTarballs, replacedCatalogEntries } =
    rewriteDependencySpecs(
      stagedPackageJsonPath,
      tarballPathByPackageName,
      catalog
    );
  const overridesApplied = applyTarballOverrides(
    stagedPackageJsonPath,
    tarballPathByPackageName
  );

  console.log(
    `Rewrote ${replacedWithTarballs.length} monorepo dependencies to tarballs and ${replacedCatalogEntries.length} catalog dependencies to versions`
  );
  console.log(
    `Applied ${overridesApplied} pnpm tarball overrides for transitive monorepo packages`
  );

  console.log(`Installing dependencies in ${stagedWorkbenchDir}`);
  run('pnpm', ['install', '--no-frozen-lockfile'], stagedWorkbenchDir);

  console.log('');
  console.log('Done.');
  console.log(`Staged workbench: ${stagedWorkbenchDir}`);
  console.log(`Tarballs: ${tarballDir}`);
}

main();
