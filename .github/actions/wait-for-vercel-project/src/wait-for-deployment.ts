import * as core from '@actions/core';
import { Vercel } from '@vercel/sdk';
import * as fs from 'fs';

interface VercelDeployment {
  uid: string;
  name: string;
  url: string;
  state: string;
  readyState: string;
  environment?: { [key: string]: string };
  target?: string;
  created: number;
  createdAt: number;
  inspectorUrl?: string;
  meta?: { [key: string]: any };
  gitSource?: {
    ref: string;
    sha: string;
    repoId?: string;
  };
}

async function run(): Promise<void> {
  try {
    // Get inputs
    const teamId = core.getInput('team-id', { required: true });
    const projectId = core.getInput('project-id', { required: true });
    const vercelToken = core.getInput('vercel-token', { required: true });
    const timeoutInput = parseInt(core.getInput('timeout') || '600', 10);
    const timeout = isNaN(timeoutInput) ? 600 : timeoutInput;
    const checkIntervalInput = parseInt(
      core.getInput('check-interval') || '10',
      10
    );
    const checkInterval = isNaN(checkIntervalInput) ? 10 : checkIntervalInput;
    const environment = core.getInput('environment') || 'Preview';

    console.log(`Waiting for Vercel deployment for project: ${projectId}`);
    console.log(`Environment: ${environment}`);
    console.log(`Timeout: ${timeout}s, Check interval: ${checkInterval}s`);

    // Initialize Vercel SDK
    const vercel = new Vercel({
      bearerToken: vercelToken,
    });

    // Get current commit SHA and git reference from GitHub context
    const githubSha = process.env.GITHUB_SHA;
    const githubRef = process.env.GITHUB_REF;
    const githubEventName = process.env.GITHUB_EVENT_NAME;
    const githubEventPath = process.env.GITHUB_EVENT_PATH;

    let targetSha = githubSha;
    let targetRef = githubRef;
    console.log(`Initial GITHUB_SHA: ${targetSha}`);
    console.log(`Initial GITHUB_REF: ${targetRef}`);

    // Try to get more specific SHA and ref from event data if available
    if (githubEventName === 'pull_request' && githubEventPath) {
      try {
        const eventData = JSON.parse(fs.readFileSync(githubEventPath, 'utf8'));
        if (eventData.pull_request?.head?.sha) {
          targetSha = eventData.pull_request.head.sha;
          console.log(`Pull request head SHA: ${targetSha}`);
        }
        if (eventData.pull_request?.head?.ref) {
          targetRef = `refs/heads/${eventData.pull_request.head.ref}`;
          console.log(`Pull request head ref: ${targetRef}`);
        }
      } catch (error) {
        console.log(`Could not read event data: ${error}`);
      }
    } else if (githubEventName === 'push' && githubEventPath) {
      try {
        const eventData = JSON.parse(fs.readFileSync(githubEventPath, 'utf8'));
        if (eventData.after) {
          targetSha = eventData.after;
          console.log(`Push event SHA: ${targetSha}`);
        }
        // For push events, GITHUB_REF is already correct
      } catch (error) {
        console.log(`Could not read event data: ${error}`);
      }
    }

    // Extract branch name from ref for Vercel API
    const branchName = targetRef?.replace('refs/heads/', '') || 'main';
    console.log(
      `Looking for deployment with commit SHA: ${targetSha} on branch: ${branchName}`
    );

    const maxAttempts = Math.floor(timeout / checkInterval);
    let attempt = 0;

    while (attempt < maxAttempts) {
      attempt++;
      console.log(`Attempt ${attempt}/${maxAttempts}`);

      try {
        // Get deployments for the project with API-level filtering
        console.log('Fetching deployments from Vercel API with filters');
        const deploymentParams: any = {
          projectId: projectId,
          limit: 10,
          teamId: teamId,
          sha: targetSha, // Filter by exact commit SHA
          branch: branchName, // Filter by git branch name
        };

        // Add target environment filter if specified
        if (environment && environment !== 'null' && environment !== '') {
          deploymentParams.target = environment.toLowerCase();
          console.log(
            `Filtering by target environment: ${environment.toLowerCase()}`
          );
        }

        console.log(
          `API filters: SHA=${targetSha}, Branch=${branchName}, Target=${deploymentParams.target || 'any'}`
        );
        const response =
          await vercel.deployments.getDeployments(deploymentParams);

        const deployments = response.deployments as VercelDeployment[];

        // Debug: Show first few deployments
        console.log('Debug: First few deployments found:');
        deployments.slice(0, 3).forEach((deployment: VercelDeployment) => {
          console.log(
            `ID: ${deployment.uid}, Name: ${deployment.name}, State: ${deployment.state}, ReadyState: ${deployment.readyState}, Target: ${deployment.target}, SHA: ${deployment.gitSource?.sha || 'N/A'}`
          );
        });

        // API has already filtered by SHA, branch, and target - check if we have any deployments
        console.log(
          `Found ${deployments.length} deployments matching SHA: ${targetSha}, Branch: ${branchName}`
        );

        const deployment: VercelDeployment | undefined =
          deployments.length > 0 ? deployments[0] : undefined;

        if (deployment) {
          console.log(`Found deployment: ${deployment.uid}`);
          console.log(`Deployment state: ${deployment.state}`);
          console.log(`Deployment readyState: ${deployment.readyState}`);

          // Check if deployment is ready
          if (
            deployment.state === 'READY' ||
            deployment.readyState === 'READY'
          ) {
            console.log('✅ Deployment is ready!');

            const deploymentUrl = `https://${deployment.url}`;
            console.log(`URL: ${deploymentUrl}`);

            core.setOutput('deployment-url', deploymentUrl);
            core.setOutput('deployment-id', deployment.uid);
            return; // Exit successfully
          } else if (
            deployment.state === 'ERROR' ||
            deployment.state === 'CANCELED'
          ) {
            throw new Error(
              `Deployment failed with state: ${deployment.state}`
            );
          } else {
            console.log(
              `🔄 Deployment in progress (state: ${deployment.state}, readyState: ${deployment.readyState})`
            );
          }
        } else {
          console.log(
            `⏳ No deployment found for SHA ${targetSha} on branch ${branchName}, waiting...`
          );
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        console.log(`⚠️ Error fetching deployments: ${errorMessage}`);
      }

      if (attempt < maxAttempts) {
        console.log(`Waiting ${checkInterval}s before next check...`);
        await new Promise((resolve) =>
          setTimeout(resolve, checkInterval * 1000)
        );
      }
    }

    throw new Error(`Timeout reached after ${timeout}s. Deployment not ready.`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    core.setFailed(errorMessage);
  }
}

run();
