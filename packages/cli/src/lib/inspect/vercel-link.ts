/**
 * This file was copied from @vercel/vercel/packages/cli/src/util/projects/link.ts
 * and adapted to work without importing most of the vercel CLI code.
 *
 * It strips:
 * - Network requests for validating whether the org/user/team/project exists
 * - Some vercel-specific environment variable checks and inference
 *   that we're not supporting for Workflow CLI for now
 */

import { execSync } from 'node:child_process';
import fs, { statSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, normalize, posix, relative } from 'node:path';
import util from 'node:util';
import { promisify } from 'util';
import { logger } from '../config/log.js';

const home = homedir();

interface RepoProjectConfig {
  id: string;
  name: string;
  directory: string;
}

interface RepoProjectsConfig {
  orgId: string;
  remoteName: string;
  projects: RepoProjectConfig[];
}

interface RepoLink {
  rootPath: string;
  repoConfigPath: string;
  repoConfig?: RepoProjectsConfig;
}

export interface ProjectLink {
  /**
   * ID of the Vercel Project.
   */
  projectId: string;
  /**
   * User or Team ID of the owner of the Vercel Project.
   */
  orgId: string;
  /**
   * When linked as a repository, contains the absolute path
   * to the root directory of the repository.
   */
  repoRoot?: string;
  /**
   * When linked as a repository, contains the relative path
   * to the selected project root directory.
   */
  projectRootDirectory?: string;
  /**
   * Name of the Vercel Project.
   */
  projectName?: string;
}

const readFile = promisify(fs.readFile);

export const VERCEL_DIR = '.vercel';
export const VERCEL_DIR_FALLBACK = '.now';
export const VERCEL_DIR_PROJECT = 'project.json';
export const VERCEL_DIR_REPO = 'repo.json';

const isDirectory = (dir: string) => {
  try {
    return statSync(dir).isDirectory();
  } catch (err) {
    logger.debug(`${dir} is not a directory: ${err}`);
    return false;
  }
};

/**
 * A type guard for `try...catch` errors.
 * @deprecated use `require('node:util').types.isNativeError(error)` instead
 */
export const isError = (error: unknown): error is Error => {
  return util.types.isNativeError(error);
};

export const isErrnoException = (
  error: unknown
): error is NodeJS.ErrnoException => {
  return isError(error) && 'code' in error;
};

export const isOneOfErrNoExceptions = (error: unknown, codes: string[]) => {
  return (
    isErrnoException(error) &&
    'code' in error &&
    error.code &&
    codes.includes(error.code)
  );
};

/**
 * Returns the `<cwd>/.vercel` directory for the current project
 * with a fallback to <cwd>/.now` if it exists.
 *
 * Throws an error if *both* `.vercel` and `.now` directories exist.
 */
export function getVercelDirectory(cwd: string): string {
  logger.debug(`Getting vercel directory for ${cwd}`);
  const possibleDirs = [join(cwd, VERCEL_DIR), join(cwd, VERCEL_DIR_FALLBACK)];
  logger.debug(`Possible vercel directories: ${possibleDirs.join(', ')}`);
  const existingDirs = possibleDirs.filter((d) => isDirectory(d));
  if (existingDirs.length > 1) {
    throw new Error(
      'CONFLICTING_CONFIG_DIRECTORIES: Both `.vercel` and `.now` directories exist. Please remove the `.now` directory.'
    );
  }
  return existingDirs[0] || possibleDirs[0];
}

export async function getProjectLink(
  path: string
): Promise<ProjectLink | null> {
  return (
    (await getProjectLinkFromRepoLink(path)) ||
    (await getLinkFromDir(getVercelDirectory(path)))
  );
}

/**
 * Convert Windows separators to Unix separators.
 */
export function normalizeOsPath(p: string): string {
  const isWin = process.platform === 'win32';
  return isWin ? p.replace(/\\/g, '/') : p;
}

function sortByDirectory(
  a: { directory: string },
  b: { directory: string }
): number {
  const aParts = a.directory.split('/');
  const bParts = b.directory.split('/');
  return bParts.length - aParts.length;
}

/**
 * Finds the matching Projects from an array of Project links
 * where the provided relative path is within the Project's
 * root directory.
 */
export function findProjectsFromPath(
  projects: RepoProjectConfig[],
  path: string
): RepoProjectConfig[] {
  logger.debug(
    `Finding projects ${JSON.stringify(projects)} from path ${path}`
  );
  const normalizedPath = normalizeOsPath(path);
  const matches = projects
    .slice()
    .sort(sortByDirectory)
    .filter((project) => {
      if (project.directory === '.') {
        // Project has no "Root Directory" setting, so any path is valid
        return true;
      }
      return (
        normalizedPath === project.directory ||
        normalizedPath.startsWith(`${project.directory}/`)
      );
    });
  // If there are multiple matches, we only want the most relevant
  // selections (with the deepest directory depth), so pick the first
  // one and filter on those matches.
  const firstMatch = matches[0];
  return matches.filter((match) => match.directory === firstMatch.directory);
}

async function getProjectLinkFromRepoLink(
  path: string
): Promise<ProjectLink | null> {
  const repoLink = await getRepoLink(path);
  if (!repoLink?.repoConfig) {
    logger.debug('No repo link found');
    return null;
  }
  logger.debug('Repo link', JSON.stringify(repoLink));
  const projects = findProjectsFromPath(
    repoLink.repoConfig.projects,
    relative(repoLink.rootPath, path)
  );
  logger.debug(`Found matching repo projects: ${JSON.stringify(projects)}`);
  if (projects.length === 1) {
    const project = projects[0];
    return {
      repoRoot: repoLink.rootPath,
      orgId: repoLink.repoConfig.orgId,
      projectId: project.id,
      projectName: project.name,
      projectRootDirectory: project.directory,
    };
  } else if (projects.length > 1) {
    throw new Error('Multiple projects found');
  }
  return null;
}

export async function getLinkFromDir(
  vercelDir: string
): Promise<ProjectLink | null> {
  logger.debug(`Getting link from dir ${vercelDir}`);
  try {
    const json = await readFile(join(vercelDir, VERCEL_DIR_PROJECT), 'utf8');
    const link: ProjectLink = JSON.parse(json);

    if (!link || !link.projectId || !link.orgId) {
      throw new Error(
        `Project Settings are invalid. To link your project again, remove the ${vercelDir} directory.`
      );
    }

    return link;
  } catch (err: unknown) {
    // link file does not exists, project is not linked
    if (isOneOfErrNoExceptions(err, ['ENOENT', 'ENOTDIR'])) {
      return null;
    }

    // link file can't be read
    if (isError(err) && err.name === 'SyntaxError') {
      throw new Error(
        `Project Settings could not be retrieved. To link your project again, remove the ${vercelDir} directory.`
      );
    }

    throw err;
  }
}

export function* traverseUpDirectories({
  start,
  base,
  maxDepth = 10,
}: {
  start: string;
  base?: string;
  maxDepth?: number;
}) {
  let current: string | undefined = normalize(start);
  const normalizedRoot = base ? normalize(base) : undefined;
  let depth = 0;
  while (current) {
    yield current;
    if (current === normalizedRoot) break;
    // Go up one directory
    const next = join(current, '..');
    current = next === current ? undefined : next;
    depth++;
    if (depth > maxDepth) {
      logger.debug(`Max traversal depth of ${maxDepth} reached`);
      break;
    }
  }
}

/**
 * Given a `start` directory, traverses up the directory hierarchy until
 * the nearest `.git/config` file is found. Returns the directory where
 * the Git config was found, or `undefined` when no Git repo was found.
 */
export async function findRepoRoot(
  cwd: string,
  start: string
): Promise<string | undefined> {
  const REPO_JSON_PATH = join(VERCEL_DIR, VERCEL_DIR_REPO);
  /**
   * If the current repo is a git submodule or git worktree '.git' is a file
   * with a pointer to the "parent" git repository instead of a directory.
   */
  const GIT_PATH = isGitWorktreeOrSubmodule(cwd)
    ? posix.normalize('.git')
    : posix.normalize('.git/config');

  for (const current of traverseUpDirectories({ start })) {
    if (current === home) {
      // Sometimes the $HOME directory is set up as a Git repo
      // (for dotfiles, etc.). In this case it's safe to say that
      // this isn't the repo we're looking for. Bail.
      logger.debug('Arrived at home directory');
      break;
    }

    // if `.vercel/repo.json` exists (already linked),
    // then consider this the repo root
    const repoConfigPath = join(current, REPO_JSON_PATH);
    let stat = await lstat(repoConfigPath).catch((err) => {
      if (err.code !== 'ENOENT') throw err;
    });
    if (stat) {
      logger.debug(
        `Found repo config "${REPO_JSON_PATH}" - detected "${current}" as repo root`
      );
      return current;
    }

    // if `.git/config` exists (unlinked),
    // then consider this the repo root
    const gitConfigPath = join(current, GIT_PATH);
    stat = await lstat(gitConfigPath).catch((err) => {
      if (err.code !== 'ENOENT') throw err;
    });
    if (stat) {
      logger.debug(
        `Found git config "${GIT_PATH}" - detected "${current}" as repo root`
      );
      return current;
    }
  }

  logger.debug('Aborting search for repo root');
}

function getGitDirectory(cwd: string): string | null {
  try {
    const gitConfigPath = execSync('git rev-parse --git-dir', {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    return gitConfigPath;
  } catch (err: unknown) {
    if (err instanceof Error) {
      logger.debug(`Failed to get git directory: ${err.message}`);
    }
    return null;
  }
}

export function isGitWorktreeOrSubmodule(cwd: string): boolean {
  const gitDir = getGitDirectory(cwd);

  if (gitDir === null) {
    return false;
  }

  const isGitWorktree = gitDir.includes('.git/worktrees/');
  const isGitSubmodule = gitDir.includes('.git/modules/');

  return isGitWorktree || isGitSubmodule;
}

/**
 * Given a directory path `cwd`, finds the root of the Git repository
 * and returns the parsed `.vercel/repo.json` file if the repository
 * has already been linked.
 */
export async function getRepoLink(cwd: string): Promise<RepoLink | undefined> {
  // Determine where the root of the repo is
  logger.debug(`Getting repo link for ${cwd}`);
  const rootPath = await findRepoRoot(cwd, './');
  if (!rootPath) {
    logger.debug('getRepoLink: No repo root found');
    return undefined;
  }

  // Read the `repo.json`, if this repo has already been linked
  const repoConfigPath = join(rootPath, VERCEL_DIR, VERCEL_DIR_REPO);
  logger.debug(`getRepoLink: Reading repo config path "${repoConfigPath}"`);
  try {
    const file = await readFile(repoConfigPath, 'utf8');
    const repoConfig: RepoProjectsConfig = JSON.parse(file);
    return { rootPath, repoConfig, repoConfigPath };
  } catch (err) {
    logger.debug(`Failed to parse ${repoConfigPath}: ${err}`);
    return undefined;
  }
}
