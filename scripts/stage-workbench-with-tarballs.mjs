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

function parseCatalogMapping(lines, startIndex, indentation) {
  const entries = {};
  const prefix = ' '.repeat(indentation);

  for (const line of lines.slice(startIndex)) {
    if (!line.trim() || line.trimStart().startsWith('#')) {
      continue;
    }
    if (!line.startsWith(prefix) || line.startsWith(`${prefix} `)) {
      break;
    }

    const match = line
      .slice(indentation)
      .match(/^(?:"([^"]+)"|(\S[^:]*)):\s*(.+)\s*$/u);
    if (!match) {
      break;
    }
    entries[match[1] ?? match[2]] = match[3].trim();
  }

  return entries;
}

export function parseCatalogEntries(yamlPath) {
  const lines = fs.readFileSync(yamlPath, 'utf8').split(/\r?\n/u);
  const defaultCatalogIndex = lines.indexOf('catalog:');
  const catalogsIndex = lines.indexOf('catalogs:');
  const catalogs = {
    default:
      defaultCatalogIndex === -1
        ? {}
        : parseCatalogMapping(lines, defaultCatalogIndex + 1, 2),
  };

  if (catalogsIndex === -1) {
    return catalogs;
  }

  for (let index = catalogsIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith('#')) {
      continue;
    }
    if (!line.startsWith(' ')) {
      break;
    }

    const match = line.match(/^ {2}(?:"([^"]+)"|(\S[^:]*)):\s*$/u);
    if (match) {
      catalogs[match[1] ?? match[2]] = parseCatalogMapping(lines, index + 1, 4);
    }
  }

  return catalogs;
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

function classifyDependencySpec(
  dependencyName,
  spec,
  tarballPathByPackageName,
  catalogs
) {
  const tarballPath = tarballPathByPackageName.get(dependencyName);
  if (tarballPath) {
    return { kind: 'tarball', spec: `file:${tarballPath}` };
  }
  if (typeof spec === 'string' && spec.startsWith('workspace:')) {
    return { kind: 'unresolved-workspace' };
  }
  if (typeof spec !== 'string' || !spec.startsWith('catalog:')) {
    return { kind: 'unchanged' };
  }

  const catalogName = spec.slice('catalog:'.length) || 'default';
  const resolvedVersion = catalogs[catalogName]?.[dependencyName];
  return resolvedVersion
    ? { kind: 'catalog', spec: resolvedVersion }
    : { kind: 'unresolved-catalog' };
}

export function rewriteDependencySpecs(
  packageJsonPath,
  tarballPathByPackageName,
  catalogs
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
      const classification = classifyDependencySpec(
        dependencyName,
        spec,
        tarballPathByPackageName,
        catalogs
      );
      switch (classification.kind) {
        case 'tarball':
          dependencies[dependencyName] = classification.spec;
          replacedWithTarballs.push(`${field}.${dependencyName}`);
          break;
        case 'catalog':
          dependencies[dependencyName] = classification.spec;
          replacedCatalogEntries.push(`${field}.${dependencyName}`);
          break;
        case 'unresolved-workspace':
          unresolvedWorkspaceSpecs.push(`${field}.${dependencyName}`);
          break;
        case 'unresolved-catalog':
          unresolvedCatalogSpecs.push(`${field}.${dependencyName}`);
          break;
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

function writeStagedWorkspaceConfig(
  destinationDir,
  yamlPath,
  tarballPathByPackageName
) {
  let workspaceYaml = fs.readFileSync(yamlPath, 'utf8');
  const packagesBlock = /^packages:\r?\n(?:(?: {2}- .*?)(?:\r?\n|$))+/u;
  if (!packagesBlock.test(workspaceYaml)) {
    throw new Error(`Could not find packages block in ${yamlPath}`);
  }
  workspaceYaml = workspaceYaml.replace(packagesBlock, 'packages:\n  - .\n');

  let overridesApplied = 0;
  const overrideLines = [];
  for (const [packageName, tarballPath] of tarballPathByPackageName.entries()) {
    overrideLines.push(
      `  ${JSON.stringify(packageName)}: ${JSON.stringify(`file:${tarballPath}`)}`
    );
    overridesApplied += 1;
  }

  const overridesHeader = /^overrides:\s*$/mu;
  if (!overridesHeader.test(workspaceYaml)) {
    throw new Error(`Could not find overrides block in ${yamlPath}`);
  }
  workspaceYaml = workspaceYaml.replace(
    overridesHeader,
    (header) => `${header}\n${overrideLines.join('\n')}`
  );

  fs.writeFileSync(
    path.join(destinationDir, 'pnpm-workspace.yaml'),
    workspaceYaml
  );
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

  const catalogs = parseCatalogEntries(workspaceYamlPath);
  const stagedPackageJsonPath = path.join(stagedWorkbenchDir, 'package.json');
  const { replacedWithTarballs, replacedCatalogEntries } =
    rewriteDependencySpecs(
      stagedPackageJsonPath,
      tarballPathByPackageName,
      catalogs
    );
  const overridesApplied = writeStagedWorkspaceConfig(
    stagedWorkbenchDir,
    workspaceYamlPath,
    tarballPathByPackageName
  );

  console.log(
    `Rewrote ${replacedWithTarballs.length} monorepo dependencies to tarballs and ${replacedCatalogEntries.length} catalog dependencies to versions`
  );
  console.log(
    `Wrote staged pnpm workspace config with ${overridesApplied} tarball overrides for transitive monorepo packages`
  );

  console.log(`Installing dependencies in ${stagedWorkbenchDir}`);
  run('pnpm', ['install', '--no-frozen-lockfile'], stagedWorkbenchDir);

  console.log('');
  console.log('Done.');
  console.log(`Staged workbench: ${stagedWorkbenchDir}`);
  console.log(`Tarballs: ${tarballDir}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main();
}
