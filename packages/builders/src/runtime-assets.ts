import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, realpath, stat } from 'node:fs/promises';
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from 'node:path';
import {
  type NodeFileTraceReasonType,
  type NodeFileTraceResult,
  nodeFileTrace,
} from '@vercel/nft';
import { buildLogger } from '@workflow/core/logger';
import { type Metafile, transform } from 'esbuild';

const GENERATED_FUNCTION_FILES = new Set([
  '.vc-config.json',
  '__step_registrations.mjs',
  '__step_registrations.mjs.map',
  'index.mjs',
  'index.mjs.map',
  'package.json',
]);

const SECRET_FILE_NAMES = new Set(['.env', '.npmrc']);
const SECRET_FILE_EXTENSIONS = new Set(['.key', '.pem']);

const TRANSPILE_LOADERS: Record<string, 'ts' | 'tsx' | 'jsx'> = {
  '.ts': 'ts',
  '.mts': 'ts',
  '.cts': 'ts',
  '.tsx': 'tsx',
  '.jsx': 'jsx',
};

function isSecretFile(filePath: string): boolean {
  const name = basename(filePath);
  return (
    SECRET_FILE_NAMES.has(name) ||
    name.startsWith('.env.') ||
    SECRET_FILE_EXTENSIONS.has(extname(name))
  );
}

function isNativeLibrary(filePath: string): boolean {
  const name = basename(filePath);
  return (
    name.endsWith('.node') ||
    name.endsWith('.dylib') ||
    name.endsWith('.dll') ||
    /\.so(?:\.|$)/.test(name)
  );
}

function getPackageDir(filePath: string): string | undefined {
  const normalized = filePath.replace(/\\/g, '/');
  const marker = '/node_modules/';
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex === -1) return;

  const segments = normalized.slice(markerIndex + marker.length).split('/');
  const packageName =
    segments[0]?.startsWith('@') || segments[0]?.startsWith('.')
      ? segments.slice(0, 2)
      : segments.slice(0, 1);
  assert(packageName.length > 0, `Invalid node_modules path: ${filePath}`);
  return join(normalized.slice(0, markerIndex + marker.length), ...packageName);
}

function isRuntimeAsset(
  file: string,
  reasonTypes: NodeFileTraceReasonType[],
  nativePackageDirs: Set<string>
): boolean {
  for (const reasonType of reasonTypes) {
    switch (reasonType) {
      case 'initial':
      case 'resolve':
      case 'dependency':
      case 'asset':
      case 'sharedlib':
        break;
      default:
        assert.fail(`Unknown nft trace reason: ${String(reasonType)}`);
    }
  }
  return (
    isNativeLibrary(file) ||
    isSecretFile(file) ||
    reasonTypes.some((type) => type === 'asset' || type === 'sharedlib') ||
    nativePackageDirs.has(getPackageDir(file) ?? '')
  );
}

async function readFileForTrace(
  filePath: string
): Promise<Buffer | string | null> {
  let contents: Buffer;
  try {
    contents = await readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }

  const loader = TRANSPILE_LOADERS[extname(filePath)];
  if (!loader) return contents;
  return (await transform(contents.toString(), { loader })).code;
}

function isInside(directory: string, filePath: string): boolean {
  const path = relative(directory, filePath);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function getOutputPaths({
  functionDir,
  sourcePath,
  workingDir,
  parentDirs,
}: {
  functionDir: string;
  sourcePath: string;
  workingDir: string;
  parentDirs: string[];
}): string[] {
  const outputPaths = new Set<string>();
  const normalizedSource = sourcePath.replace(/\\/g, '/');
  const nodeModulesMarker = '/node_modules/';
  const nodeModulesIndex = normalizedSource.lastIndexOf(nodeModulesMarker);

  if (nodeModulesIndex !== -1) {
    outputPaths.add(
      join(
        functionDir,
        'node_modules',
        normalizedSource.slice(nodeModulesIndex + nodeModulesMarker.length)
      )
    );
  }

  if (isInside(workingDir, sourcePath)) {
    outputPaths.add(join(functionDir, relative(workingDir, sourcePath)));
  }

  for (const parentDir of parentDirs) {
    const outputPath = resolve(functionDir, relative(parentDir, sourcePath));
    if (isInside(functionDir, outputPath) && outputPath !== functionDir) {
      outputPaths.add(outputPath);
    }
  }

  return [...outputPaths];
}

type RuntimeFile = { sourcePath: string; parentDirs: string[] };

async function getRuntimeFiles(
  { fileList, reasons }: NodeFileTraceResult,
  traceBase: string
): Promise<RuntimeFile[]> {
  const absolutePath = (filePath: string) =>
    isAbsolute(filePath) ? filePath : join(traceBase, filePath);
  const nativePackageDirs = new Set(
    [...fileList]
      .map(absolutePath)
      .filter(isNativeLibrary)
      .map(getPackageDir)
      .filter((packageDir) => packageDir !== undefined)
  );
  const runtimeFiles: RuntimeFile[] = [];

  for (const file of fileList) {
    const reason = reasons.get(file);
    assert(reason, `Missing trace reason for ${file}`);

    const sourcePath = absolutePath(file);
    if (!isRuntimeAsset(sourcePath, reason.type, nativePackageDirs)) continue;
    if (isSecretFile(sourcePath)) {
      throw new Error(
        `Refusing to deploy secret-like runtime asset: ${sourcePath}`
      );
    }
    const sourceStats = await stat(sourcePath);
    if (sourceStats.isDirectory()) continue;
    assert(sourceStats.isFile(), `Runtime asset is not a file: ${sourcePath}`);

    runtimeFiles.push({
      sourcePath,
      parentDirs:
        isNativeLibrary(sourcePath) ||
        reason.type.some((type) => type === 'asset' || type === 'sharedlib')
          ? [...reason.parents].map((parent) => dirname(absolutePath(parent)))
          : [],
    });
  }

  for (const packageDir of nativePackageDirs) {
    const sourcePath = join(packageDir, 'package.json');
    assert(
      existsSync(sourcePath),
      `Native package has no package.json: ${packageDir}`
    );
    runtimeFiles.push({ sourcePath, parentDirs: [] });
  }

  return runtimeFiles;
}

async function copyRuntimeFiles(
  runtimeFiles: RuntimeFile[],
  functionDir: string,
  workingDir: string
): Promise<number> {
  const copied = new Map<string, string>();

  for (const runtimeFile of runtimeFiles) {
    const realSourcePath = await realpath(runtimeFile.sourcePath);
    const outputPaths = getOutputPaths({
      functionDir,
      sourcePath: runtimeFile.sourcePath,
      workingDir,
      parentDirs: runtimeFile.parentDirs,
    });
    if (outputPaths.length === 0) {
      throw new Error(
        `Runtime asset cannot be placed in the function: ${runtimeFile.sourcePath}`
      );
    }

    for (const outputPath of outputPaths) {
      const outputFile = relative(functionDir, outputPath).replace(/\\/g, '/');
      if (GENERATED_FUNCTION_FILES.has(outputFile)) {
        throw new Error(
          `Runtime asset conflicts with generated function output: ${runtimeFile.sourcePath}`
        );
      }

      const existingSource = copied.get(outputPath);
      if (existingSource && existingSource !== realSourcePath) {
        throw new Error(
          `Conflicting runtime assets for ${outputFile}: ${existingSource} and ${realSourcePath}`
        );
      }
      if (existingSource) continue;

      await mkdir(dirname(outputPath), { recursive: true });
      await copyFile(realSourcePath, outputPath);
      copied.set(outputPath, realSourcePath);
    }
  }

  return copied.size;
}

export async function copyRuntimeAssets({
  functionDir,
  workingDir,
  metafile,
}: {
  functionDir: string;
  workingDir: string;
  metafile: Metafile;
}): Promise<number> {
  const entries = Object.keys(metafile.inputs)
    .map((input) => resolve(workingDir, input))
    .filter(existsSync);
  assert(entries.length > 0, 'The steps bundle has no traceable inputs');

  const traceBase = parse(workingDir).root;
  const realWorkingDir = await realpath(workingDir);
  const trace = await nodeFileTrace(entries, {
    base: traceBase,
    processCwd: workingDir,
    mixedModules: true,
    readFile: readFileForTrace,
  });
  for (const warning of trace.warnings) {
    buildLogger.debug(`Runtime asset trace warning: ${warning.message}`);
  }
  const runtimeFiles = await getRuntimeFiles(trace, traceBase);
  return copyRuntimeFiles(runtimeFiles, functionDir, realWorkingDir);
}
