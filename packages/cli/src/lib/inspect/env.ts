import type { Dirent } from 'node:fs';
import { access, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { findWorkflowDataDir } from '@workflow/utils/check-data-dir';
import { logger } from '../config/log.js';
import { getWorkflowConfig } from '../config/workflow-config.js';
import { getAuthToken } from './auth.js';
import { fetchTeamInfo } from './vercel-api.js';
import {
  findRepoRoot,
  getProjectLink,
  isOneOfErrNoExceptions,
  type ProjectLink,
} from './vercel-link.js';

/**
 * Overwrite values on process.env with the given values (if not undefined)
 *
 * Used by the CLI to configure environment variables that are read by
 * various subsystems (e.g., WORKFLOW_TARGET_WORLD, WORKFLOW_LOCAL_DATA_DIR).
 * Note: WORKFLOW_VERCEL_* env vars are read back via getEnvVars() and passed
 * to @workflow/world-vercel's createWorld() explicitly; they are NOT read by runtime createWorld().
 */
export const writeEnvVars = (envVars: Record<string, string>) => {
  Object.entries(envVars).forEach(([key, value]) => {
    if (
      value === undefined ||
      value === null ||
      value === '' ||
      value === 'undefined'
    ) {
      return;
    }
    process.env[key] = value;
  });
};

export const getEnvVars = (): Record<string, string> => {
  const env = process.env;
  return {
    WORKFLOW_TARGET_WORLD: env.WORKFLOW_TARGET_WORLD || '',
    WORKFLOW_VERCEL_ENV: env.WORKFLOW_VERCEL_ENV || '',
    WORKFLOW_VERCEL_AUTH_TOKEN: env.WORKFLOW_VERCEL_AUTH_TOKEN || '',
    WORKFLOW_VERCEL_PROJECT: env.WORKFLOW_VERCEL_PROJECT || '',
    WORKFLOW_VERCEL_PROJECT_NAME: env.WORKFLOW_VERCEL_PROJECT_NAME || '',
    WORKFLOW_VERCEL_TEAM: env.WORKFLOW_VERCEL_TEAM || '',
    WORKFLOW_LOCAL_BASE_URL: env.WORKFLOW_LOCAL_BASE_URL || '',
    WORKFLOW_LOCAL_UI: env.WORKFLOW_LOCAL_UI || '',
    PORT: env.PORT || '',
    WORKFLOW_LOCAL_DATA_DIR: env.WORKFLOW_LOCAL_DATA_DIR || '',
    WORKFLOW_MANIFEST_PATH: env.WORKFLOW_MANIFEST_PATH || '',
  };
};

const possibleManifestPaths = [
  'app/.well-known/workflow/v1/manifest.json',
  'src/app/.well-known/workflow/v1/manifest.json',
  '.well-known/workflow/v1/manifest.json',
];

// App directories a route-prefixed manifest can sit below, as
// `<appDir>/<prefix>/.well-known/workflow/v1/manifest.json` (Next.js'
// `workflows.experimentalRoutePrefix`).
const prefixedManifestAppDirs = ['app', 'src/app'];

const fileExists = (path: string) =>
  access(path)
    .then(() => true)
    .catch(() => false);

/**
 * Every `.well-known/workflow/v1/manifest.json` below `appDir`, sorted.
 *
 * Mirrors the Next.js builder's stale-route sweep: it skips `node_modules`
 * and dot directories, and stops at the first `.well-known`. The builder
 * rejects route prefixes with `.`-prefixed segments, so a prefixed manifest
 * is never hidden below one.
 */
export async function findPrefixedManifestPaths(
  appDir: string
): Promise<string[]> {
  const found: string[] = [];
  const visit = async (dir: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isDirectory()) {
          return;
        }
        if (entry.name === '.well-known') {
          const manifest = join(dir, entry.name, 'workflow/v1/manifest.json');
          if (await fileExists(manifest)) {
            found.push(resolve(manifest));
          }
          return;
        }
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) {
          return;
        }
        await visit(join(dir, entry.name));
      })
    );
  };
  await visit(appDir);
  return found.sort();
}

export async function findManifestPath(cwd: string) {
  for (const path of possibleManifestPaths) {
    const fullPath = join(cwd, path);
    if (await fileExists(fullPath)) {
      const absolutePath = resolve(fullPath);
      logger.debug('Found workflow manifest:', absolutePath);
      return absolutePath;
    }
  }

  // No manifest at the app root: look for one generated below a route prefix.
  for (const appDir of prefixedManifestAppDirs) {
    const [first, ...rest] = await findPrefixedManifestPaths(join(cwd, appDir));
    if (first) {
      if (rest.length > 0) {
        logger.debug(
          `Found ${rest.length + 1} prefixed workflow manifests, using ${first}. Set WORKFLOW_MANIFEST_PATH to choose another.`
        );
      }
      logger.debug('Found workflow manifest:', first);
      return first;
    }
  }
}

/**
 * Overwrites process.env variables related to local world configuration,
 * if relevant environment variables aren't set already.
 *
 * Throws if the workflow data directory can not be found.
 */
export const inferLocalWorldEnvVars = async () => {
  const envVars = getEnvVars();
  const cwd = getWorkflowConfig().workingDir;
  let repoRoot: string | undefined;

  // Always expose the effective working directory to the web UI/server-side helpers.
  // This is especially useful when developing the web UI from the workflow repo
  // while targeting another project directory.
  if (!process.env.WORKFLOW_OBSERVABILITY_CWD) {
    writeEnvVars({ WORKFLOW_OBSERVABILITY_CWD: cwd });
  }

  // Set default base URL for local queue if not already configured
  // We use WORKFLOW_LOCAL_BASE_URL instead of PORT to avoid conflicts
  // with other tools (like Next.js) that also use the PORT env var
  if (!envVars.WORKFLOW_LOCAL_BASE_URL && !envVars.PORT) {
    logger.debug(
      'Using default queue target http://localhost:3000, set WORKFLOW_LOCAL_BASE_URL or PORT to override.'
    );
    envVars.WORKFLOW_LOCAL_BASE_URL = 'http://localhost:3000';
    writeEnvVars(envVars);
  }

  // Infer workflow data directory
  if (!envVars.WORKFLOW_LOCAL_DATA_DIR) {
    const localResult = await findWorkflowDataDir(cwd);
    if (localResult.dataDir) {
      logger.debug('Found workflow data directory:', localResult.dataDir);
      envVars.WORKFLOW_LOCAL_DATA_DIR = localResult.dataDir;
      writeEnvVars(envVars);
    } else {
      // As a fallback, find the repo root, and try to infer the data dir from there
      repoRoot = await findRepoRoot(cwd, cwd);
      if (repoRoot) {
        const repoResult = await findWorkflowDataDir(repoRoot);
        if (repoResult.dataDir) {
          logger.debug('Found workflow data directory:', repoResult.dataDir);
          envVars.WORKFLOW_LOCAL_DATA_DIR = repoResult.dataDir;
          writeEnvVars(envVars);
        }
      }
      if (!envVars.WORKFLOW_LOCAL_DATA_DIR) {
        const message = `No workflow data directory found in "${cwd}". Have you run any workflows yet?`;
        throw new Error(message);
      }
    }
  }

  // Infer workflow manifest path (for Graph tab in web UI)
  if (!envVars.WORKFLOW_MANIFEST_PATH) {
    const localManifest = await findManifestPath(cwd);
    if (localManifest) {
      envVars.WORKFLOW_MANIFEST_PATH = localManifest;
      writeEnvVars(envVars);
      logger.debug(`Found workflow manifest at: ${localManifest}`);
    } else {
      // As a fallback, find the repo root, and try to infer the manifest from there
      if (!repoRoot) {
        repoRoot = await findRepoRoot(cwd, cwd);
      }
      if (repoRoot) {
        const repoManifest = await findManifestPath(repoRoot);
        if (repoManifest) {
          envVars.WORKFLOW_MANIFEST_PATH = repoManifest;
          writeEnvVars(envVars);
          logger.debug(`Found workflow manifest at: ${repoManifest}`);
        }
      }

      // If the manifest is not found, the web UI will show no workflows.
      if (!envVars.WORKFLOW_MANIFEST_PATH) {
        logger.debug(
          'No workflow manifest found. Workflows tab will be empty.'
        );
      }
    }
  }
};

export const inferVercelProjectAndTeam = async () => {
  const cwd = getWorkflowConfig().workingDir;
  let project: ProjectLink | null = null;
  try {
    logger.debug(`Inferring project and team from CWD: ${cwd}`);
    project = await getProjectLink(cwd);
  } catch (error) {
    if (!isOneOfErrNoExceptions(error, ['ENOENT'])) {
      throw error;
    }
  }
  if (!project) {
    logger.debug('Could not find project link folder');
    return;
  }
  logger.debug(`Found project ${project.projectId} and team ${project.orgId}`);
  return {
    projectId: project.projectId,
    projectName: project.projectName,
    teamId: project.orgId,
  };
};

/**
 * Merges a `.vercel` link into the explicitly configured project/team values.
 *
 * Explicit values are never replaced. The link fills in missing values, and
 * its project ID/name are only used when the link refers to the same project
 * as an explicit `--project` (matched by ID or name), so a stale or unrelated
 * link cannot redirect lookups to another project.
 */
export const resolveProjectFromLink = (
  envVars: Record<string, string>,
  link: { projectId: string; projectName?: string; teamId: string }
) => {
  const explicitProject = envVars.WORKFLOW_VERCEL_PROJECT;
  const explicitTeam = envVars.WORKFLOW_VERCEL_TEAM;
  const linkMatches =
    !explicitProject ||
    explicitProject === link.projectId ||
    (!!link.projectName && explicitProject === link.projectName);

  if (!linkMatches) {
    logger.debug(
      `Ignoring linked project ${link.projectName || link.projectId}: --project ${explicitProject} was given explicitly`
    );
    const team = explicitTeam || link.teamId;
    if (!explicitTeam) {
      logger.warn(
        `--team was not given, using team ${link.teamId} from the .vercel link for project ${explicitProject}`
      );
    }
    return {
      WORKFLOW_VERCEL_PROJECT: explicitProject,
      WORKFLOW_VERCEL_PROJECT_NAME:
        envVars.WORKFLOW_VERCEL_PROJECT_NAME ||
        (explicitProject.startsWith('prj_') ? '' : explicitProject),
      WORKFLOW_VERCEL_TEAM: team,
    };
  }

  return {
    // WORKFLOW_VERCEL_PROJECT is the project ID (e.g., prj_xxx)
    WORKFLOW_VERCEL_PROJECT: link.projectId,
    // WORKFLOW_VERCEL_PROJECT_NAME is the project slug (e.g., my-app)
    WORKFLOW_VERCEL_PROJECT_NAME:
      envVars.WORKFLOW_VERCEL_PROJECT_NAME ||
      link.projectName ||
      link.projectId,
    WORKFLOW_VERCEL_TEAM: explicitTeam || link.teamId,
  };
};

export interface VercelEnvVars {
  token?: string;
  environment?: string;
  projectId?: string;
  projectName?: string;
  teamId?: string;
}

/**
 * Infers Vercel World configuration from the local environment (`.vercel`
 * folder, CLI auth file, Vercel API) and returns a resolved config object.
 *
 * Also writes the resolved values to `process.env` so the embedded web UI
 * (which reads `process.env` as a fallback) can pick them up.
 */
export const inferVercelEnvVars = async (): Promise<VercelEnvVars> => {
  const envVars = getEnvVars();

  // Precedence: explicit values (CLI flags, which oclif seeds from the
  // WORKFLOW_VERCEL_* env vars when absent) always win over the `.vercel`
  // link. The link only fills in values that were not given explicitly.
  const explicitProject = envVars.WORKFLOW_VERCEL_PROJECT;
  const needsInference =
    !explicitProject ||
    !envVars.WORKFLOW_VERCEL_TEAM ||
    !envVars.WORKFLOW_VERCEL_PROJECT_NAME ||
    !explicitProject.startsWith('prj_');

  if (needsInference) {
    logger.debug('Inferring vercel project and team from .vercel folder');
    const inferred = await inferVercelProjectAndTeam();
    if (inferred) {
      Object.assign(envVars, resolveProjectFromLink(envVars, inferred));
    } else if (!explicitProject || !envVars.WORKFLOW_VERCEL_TEAM) {
      logger.warn(
        'Could not infer vercel project and team from .vercel folder, server authentication might fail.'
      );
    }
  }

  if (!envVars.WORKFLOW_VERCEL_AUTH_TOKEN) {
    logger.debug('Inferring vercel auth token from CLI auth file');
    const token = await getAuthToken();
    if (!token) {
      throw new Error('Could not find credentials. Run `vc login` to log in.');
    }
    envVars.WORKFLOW_VERCEL_AUTH_TOKEN = token;
  }

  // Fetch team information from Vercel API to get the team slug
  // TODO: To redirect to the Vercel dashboard correctly, we need to
  // resolve the team name, which is a whole API request. The alternative would be to
  // change front to allow passing in the team slug directly, or add some generic redirect.
  if (envVars.WORKFLOW_VERCEL_TEAM && envVars.WORKFLOW_VERCEL_AUTH_TOKEN) {
    logger.info('Vercel project detected. Loading project data...');
    logger.debug('Fetching team information from Vercel API');
    const teamInfo = await fetchTeamInfo(
      envVars.WORKFLOW_VERCEL_TEAM,
      envVars.WORKFLOW_VERCEL_AUTH_TOKEN
    );
    if (teamInfo) {
      envVars.WORKFLOW_VERCEL_TEAM = teamInfo.teamSlug;
      logger.debug(`Found team slug: ${teamInfo.teamSlug}`);
    }
  }

  // Write resolved values to process.env for the embedded web UI, which
  // reads them as fallbacks in its server actions.
  writeEnvVars(envVars);

  return {
    token: envVars.WORKFLOW_VERCEL_AUTH_TOKEN || undefined,
    environment: envVars.WORKFLOW_VERCEL_ENV || undefined,
    projectId: envVars.WORKFLOW_VERCEL_PROJECT || undefined,
    projectName: envVars.WORKFLOW_VERCEL_PROJECT_NAME || undefined,
    teamId: envVars.WORKFLOW_VERCEL_TEAM || undefined,
  };
};
