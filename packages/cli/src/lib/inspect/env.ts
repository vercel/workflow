import { findWorkflowDataDir } from '@workflow/utils/check-data-dir';
import { logger } from '../config/log.js';
import { getWorkflowConfig } from '../config/workflow-config.js';
import { getAuth } from './auth.js';
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
 * We do this because the core world init code reads from environment
 * (or workflow.config.ts soon) on first invocations, so CLI needs to
 * overwrite the values.
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
    WORKFLOW_VERCEL_TEAM: env.WORKFLOW_VERCEL_TEAM || '',
    WORKFLOW_VERCEL_BACKEND_URL: env.WORKFLOW_VERCEL_BACKEND_URL || '',
    WORKFLOW_LOCAL_UI: env.WORKFLOW_LOCAL_UI || '',
    PORT: env.PORT || '',
    WORKFLOW_LOCAL_DATA_DIR: env.WORKFLOW_LOCAL_DATA_DIR || '',
  };
};

/**
 * Overwrites process.env variables related to local world configuration,
 * if relevant environment variables aren't set already.
 *
 * Throws if the workflow data directory can not be found.
 */
export const inferLocalWorldEnvVars = async () => {
  const envVars = getEnvVars();
  if (!envVars.PORT) {
    logger.warn(
      'PORT environment variable is not set, using default port 3000'
    );
    envVars.PORT = '3000';
    writeEnvVars(envVars);
  }

  // Paths to check, in order of preference
  if (!envVars.WORKFLOW_LOCAL_DATA_DIR) {
    const cwd = getWorkflowConfig().workingDir;

    const localResult = await findWorkflowDataDir(cwd);
    if (localResult) {
      logger.debug('Found workflow data directory:', localResult.dataDir);
      envVars.WORKFLOW_LOCAL_DATA_DIR = localResult.dataDir;
      writeEnvVars(envVars);
      return;
    }

    // As a fallback, find the repo root, and try to infer the data dir from there
    const repoRoot = await findRepoRoot(cwd, cwd);
    if (repoRoot) {
      const repoResult = await findWorkflowDataDir(repoRoot);
      if (repoResult) {
        logger.debug('Found workflow data directory:', repoResult.dataDir);
        envVars.WORKFLOW_LOCAL_DATA_DIR = repoResult.dataDir;
        writeEnvVars(envVars);
        return;
      }
    }

    logger.warn(
      `No workflow data directory found in "${cwd}". Have you run any workflows yet?`
    );
    throw new Error('No workflow data found');
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
 * Overwrites process.env variables related to Vercel World configuration,
 * if relevant environment variables aren't set already.
 */
export const inferVercelEnvVars = async () => {
  const envVars = getEnvVars();

  if (!envVars.WORKFLOW_VERCEL_PROJECT || !envVars.WORKFLOW_VERCEL_TEAM) {
    logger.debug('Inferring vercel project and team from .vercel folder');
    const inferredProject = await inferVercelProjectAndTeam();
    if (inferredProject) {
      const { projectId, projectName, teamId } = inferredProject;
      envVars.WORKFLOW_VERCEL_PROJECT = projectName || projectId;
      envVars.WORKFLOW_VERCEL_TEAM = teamId;
      writeEnvVars(envVars);
    } else {
      logger.warn(
        'Could not infer vercel project and team from .vercel folder, server authentication might fail.'
      );
    }
  }

  if (!envVars.WORKFLOW_VERCEL_AUTH_TOKEN) {
    logger.debug('Inferring vercel auth token from CLI auth file');
    const auth = getAuth();
    if (!auth) {
      throw new Error('Could not find credentials. Run `vc login` to log in.');
    }
    envVars.WORKFLOW_VERCEL_AUTH_TOKEN = auth.token;
    writeEnvVars(envVars);
  }

  // Fetch team information from Vercel API to get the team slug
  // TODO: Sadly, in order to redirect to Vercel dashboard correctly, we need to
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
      writeEnvVars(envVars);
      logger.debug(`Found team slug: ${teamInfo.teamSlug}`);
    }
  }
};
