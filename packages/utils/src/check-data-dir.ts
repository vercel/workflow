import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

/**
 * Known paths where workflow data might be stored, relative to the project root.
 */
export const possibleWorkflowDataPaths = [
  '.next/workflow-data',
  '.workflow-data',
  'workflow-data',
] as const;

export interface WorkflowDataDirInfo {
  /** Absolute path to the project root (parent of the workflow data folder) */
  projectDir: string;
  /** Absolute path to the workflow data directory */
  dataDir: string;
  /** Short name for display: up to last two folder names of projectDir */
  shortName: string;
}

/**
 * Expands a path that starts with ~ to use the user's home directory.
 */
function expandTilde(path: string): string {
  if (path.startsWith('~')) {
    return join(homedir(), path.slice(1));
  }
  return path;
}

/**
 * Normalizes a path to an absolute path.
 */
function toAbsolutePath(path: string, basePath?: string): string {
  const expanded = expandTilde(path);
  if (isAbsolute(expanded)) {
    return resolve(expanded);
  }
  return resolve(basePath || process.cwd(), expanded);
}

/**
 * Extracts up to the last two folder names from a path for a short display name.
 *
 * Examples:
 * - `/Users/peter/code/myproject` → `code/myproject`
 * - `/myproject` → `myproject`
 * - `/` → ``
 */
function getShortName(projectDir: string): string {
  const parts = projectDir.split(sep).filter(Boolean);
  if (parts.length === 0) {
    return '';
  }
  if (parts.length === 1) {
    return parts[0];
  }
  return parts.slice(-2).join('/');
}

/**
 * Checks if a directory exists.
 */
async function directoryExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks if the given path is itself a workflow data directory
 * (ends with one of the possibleWorkflowDataPaths).
 *
 * Returns the matching suffix and the projectDir if found.
 */
function checkIfPathIsWorkflowDataDir(
  absolutePath: string
): { suffix: string; projectDir: string } | null {
  for (const suffix of possibleWorkflowDataPaths) {
    // Handle both forward slashes and the platform's separator
    const normalizedSuffix = suffix.split('/').join(sep);
    if (absolutePath.endsWith(normalizedSuffix)) {
      // Calculate how many directories up we need to go
      const suffixParts = suffix.split('/').length;
      let projectDir = absolutePath;
      for (let i = 0; i < suffixParts; i++) {
        projectDir = dirname(projectDir);
      }
      return { suffix, projectDir };
    }
  }
  return null;
}

/**
 * Finds the workflow data directory starting from the given path.
 *
 * This function handles several cases:
 * 1. The path itself is a workflow data directory
 * 2. The path contains one of the known workflow data directories
 * 3. The path is somewhere inside a project with workflow data
 *
 * @param cwd - The directory to start searching from (can be relative, absolute, or use ~)
 * @returns Information about the found workflow data directory, or null if not found
 */
export async function findWorkflowDataDir(
  cwd: string
): Promise<WorkflowDataDirInfo | null> {
  const absoluteCwd = toAbsolutePath(cwd);

  // Case 1: Check if the path itself is already a workflow data directory
  const isDataDir = checkIfPathIsWorkflowDataDir(absoluteCwd);
  if (isDataDir && (await directoryExists(absoluteCwd))) {
    return {
      projectDir: isDataDir.projectDir,
      dataDir: absoluteCwd,
      shortName: getShortName(isDataDir.projectDir),
    };
  }

  // Case 2: Check if cwd contains one of the workflow data directories
  for (const path of possibleWorkflowDataPaths) {
    const fullPath = join(absoluteCwd, path);
    if (await directoryExists(fullPath)) {
      return {
        projectDir: absoluteCwd,
        dataDir: resolve(fullPath),
        shortName: getShortName(absoluteCwd),
      };
    }
  }

  // Case 3: Walk up the directory tree to find the project root
  let currentDir = absoluteCwd;
  const root = resolve('/');

  while (currentDir !== root) {
    // Check if any workflow data path exists here
    for (const path of possibleWorkflowDataPaths) {
      const fullPath = join(currentDir, path);
      if (await directoryExists(fullPath)) {
        return {
          projectDir: currentDir,
          dataDir: resolve(fullPath),
          shortName: getShortName(currentDir),
        };
      }
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      break; // Reached the filesystem root
    }
    currentDir = parentDir;
  }

  return null;
}
