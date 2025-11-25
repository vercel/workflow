import cp from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(cp.exec);

interface PackageJson {
  name: string;
  version: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

const rootDir = fileURLToPath(new URL('../../', import.meta.url));
const packagesDir = path.join(rootDir, 'packages');
const outDir = fileURLToPath(new URL('../public', import.meta.url));

async function main() {
  const sha = await getSha();

  // Ensure output directory exists
  await fs.mkdir(outDir, { recursive: true });

  // Scan the packages directory for all packages
  const packageDirs = await fs.readdir(packagesDir);
  const packages: Array<{
    name: string;
    dir: string;
    packageJson: PackageJson;
  }> = [];

  for (const packageDir of packageDirs) {
    const dir = path.join(packagesDir, packageDir);
    const packageJsonPath = path.join(dir, 'package.json');

    try {
      const stat = await fs.stat(packageJsonPath);
      if (!stat.isFile()) continue;
    } catch {
      continue; // Skip directories without package.json
    }

    const packageJsonContent = await fs.readFile(packageJsonPath, 'utf8');
    const packageJson: PackageJson = JSON.parse(packageJsonContent);

    // Skip private packages
    if (packageJson.private) continue;

    packages.push({ name: packageJson.name, dir, packageJson });
  }

  // Create a set of all package names for dependency resolution
  const packageNames = new Set(packages.map((p) => p.name));

  for (const { name, dir, packageJson } of packages) {
    const packageJsonPath = path.join(dir, 'package.json');
    const originalPackageJson = JSON.stringify(packageJson, null, 2);

    // Create modified package.json with preview version
    const modifiedPackageJson: PackageJson = JSON.parse(originalPackageJson);
    modifiedPackageJson.version += `-${sha}`;

    // Update workspace dependencies to use preview tarball URLs
    const updateDeps = (deps: Record<string, string> | undefined) => {
      if (!deps) return;
      for (const depName of Object.keys(deps)) {
        if (packageNames.has(depName)) {
          const escapedName = depName.replace(/^@(.+)\//, '$1-');
          deps[depName] =
            `https://${process.env.VERCEL_URL}/${escapedName}.tgz`;
        }
      }
    };

    updateDeps(modifiedPackageJson.dependencies);
    updateDeps(modifiedPackageJson.devDependencies);
    updateDeps(modifiedPackageJson.peerDependencies);

    // Write modified package.json
    await fs.writeFile(
      packageJsonPath,
      JSON.stringify(modifiedPackageJson, null, 2)
    );

    try {
      // Pack the package
      await exec(`pnpm pack --out="${outDir}/%s.tgz"`, { cwd: dir });
      console.log(`Packed ${name}`);
    } finally {
      // Always restore original package.json
      await fs.writeFile(packageJsonPath, originalPackageJson);
    }
  }

  console.log(
    `\nSuccessfully packed ${packages.length} preview packages to ${outDir}`
  );
}

async function getSha(): Promise<string> {
  try {
    const { stdout } = await exec('git rev-parse --short HEAD', {
      cwd: rootDir,
    });
    return stdout.trim();
  } catch (error) {
    console.error('Failed to get git SHA:', error);
    console.log('Using "local" as the SHA.');
    return 'local';
  }
}

main().catch((err) => {
  console.error('Error running pack:', err);
  process.exit(1);
});
