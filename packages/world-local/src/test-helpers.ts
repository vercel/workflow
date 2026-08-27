import {
  accessSync,
  chmodSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  Hook,
  SerializedData,
  Step,
  Storage,
  Wait,
  WorkflowRun,
} from '@workflow/world';
import { SPEC_VERSION_CURRENT } from '@workflow/world';

/**
 * Test helper functions for creating and updating storage entities through events.
 * These helpers simplify test setup by providing a convenient API for common operations.
 */

/**
 * Which parts of the POSIX permission model this process is actually subject
 * to, probed once at import time.
 *
 * Tests that simulate an I/O failure with `chmod` need the filesystem to
 * genuinely refuse the operation, and that is not a given. `chmod` itself
 * still succeeds for root and for any process holding CAP_DAC_OVERRIDE /
 * CAP_DAC_READ_SEARCH — common when the suite runs as root in a container or
 * inside a dev sandbox — but the bits it sets are then ignored, so the
 * simulation silently becomes a no-op and the assertion fails for a reason
 * that has nothing to do with the code under test. On Windows, `chmod` on a
 * directory is a no-op to begin with.
 *
 * The three capabilities are probed separately because they are bypassed
 * independently: with CAP_DAC_OVERRIDE a real read or write of a mode-000
 * directory succeeds while `access()` still reports EACCES, because that
 * check is made against the real UID.
 */
export const permissionEnforcement = probePermissionEnforcement();

function probePermissionEnforcement(): {
  /** `fs.access()` reports EACCES for a mode the permission bits deny. */
  accessCheck: boolean;
  /** A real read of an unreadable directory is refused. */
  read: boolean;
  /** A real write into a non-writable directory is refused. */
  write: boolean;
} {
  if (process.platform === 'win32') {
    return { accessCheck: false, read: false, write: false };
  }

  const probeDir = mkdtempSync(path.join(tmpdir(), 'workflow-perm-probe-'));
  const unreadableDir = path.join(probeDir, 'unreadable');
  const readOnlyDir = path.join(probeDir, 'read-only');

  try {
    mkdirSync(unreadableDir);
    writeFileSync(path.join(unreadableDir, 'entry'), '');
    chmodSync(unreadableDir, 0o000);

    mkdirSync(readOnlyDir);
    chmodSync(readOnlyDir, 0o555);

    return {
      accessCheck: isRefused(() => accessSync(unreadableDir, constants.R_OK)),
      read: isRefused(() => readdirSync(unreadableDir)),
      write: isRefused(() =>
        writeFileSync(path.join(readOnlyDir, 'probe'), '')
      ),
    };
  } finally {
    // Restore the bits before removing the probe tree, so cleanup works on the
    // platforms where those bits are enforced.
    for (const dir of [unreadableDir, readOnlyDir]) {
      try {
        chmodSync(dir, 0o755);
      } catch {
        // The directory was never created; nothing to restore.
      }
    }
    rmSync(probeDir, { recursive: true, force: true });
  }
}

function isRefused(operation: () => unknown): boolean {
  try {
    operation();
    return false;
  } catch {
    return true;
  }
}

/**
 * Create a new workflow run through the run_created event.
 */
export async function createRun(
  storage: Storage,
  data: {
    deploymentId: string;
    workflowName: string;
    input: SerializedData;
    executionContext?: Record<string, unknown>;
    attributes?: Record<string, string>;
  }
): Promise<WorkflowRun> {
  const result = await storage.events.create(null, {
    eventType: 'run_created',
    specVersion: SPEC_VERSION_CURRENT,
    eventData: data,
  });
  if (!result.run) {
    throw new Error('Expected run to be created');
  }
  return result.run;
}

/**
 * Update a workflow run's status through lifecycle events.
 */
export async function updateRun(
  storage: Storage,
  runId: string,
  eventType: 'run_started' | 'run_completed' | 'run_failed' | 'run_cancelled',
  eventData?: Record<string, unknown>
): Promise<WorkflowRun> {
  const result = await storage.events.create(runId, {
    eventType,
    specVersion: SPEC_VERSION_CURRENT,
    eventData,
  } as any);
  if (!result.run) {
    throw new Error('Expected run to be updated');
  }
  return result.run;
}

/**
 * Create a new step through the step_created event.
 */
export async function createStep(
  storage: Storage,
  runId: string,
  data: {
    stepId: string;
    stepName: string;
    input: SerializedData;
  }
): Promise<Step> {
  const result = await storage.events.create(runId, {
    eventType: 'step_created',
    specVersion: SPEC_VERSION_CURRENT,
    correlationId: data.stepId,
    eventData: { stepName: data.stepName, input: data.input },
  });
  if (!result.step) {
    throw new Error('Expected step to be created');
  }
  return result.step;
}

/**
 * Update a step's status through lifecycle events.
 */
export async function updateStep(
  storage: Storage,
  runId: string,
  stepId: string,
  eventType:
    | 'step_started'
    | 'step_completed'
    | 'step_failed'
    | 'step_retrying',
  eventData?: Record<string, unknown>
): Promise<Step> {
  const result = await storage.events.create(runId, {
    eventType,
    specVersion: SPEC_VERSION_CURRENT,
    correlationId: stepId,
    eventData,
  } as any);
  if (!result.step) {
    throw new Error('Expected step to be updated');
  }
  return result.step;
}

/**
 * Create a new hook through the hook_created event.
 */
export async function createHook(
  storage: Storage,
  runId: string,
  data: {
    hookId: string;
    token: string;
    tokenRetentionUntil?: Date;
    metadata?: SerializedData;
  }
): Promise<Hook> {
  const { hookId, ...eventData } = data;
  const result = await storage.events.create(runId, {
    eventType: 'hook_created',
    specVersion: SPEC_VERSION_CURRENT,
    correlationId: hookId,
    eventData,
  });
  if (!result.hook) {
    throw new Error('Expected hook to be created');
  }
  return result.hook;
}

/**
 * Dispose a hook through the hook_disposed event.
 */
export async function disposeHook(
  storage: Storage,
  runId: string,
  hookId: string
): Promise<void> {
  await storage.events.create(runId, {
    eventType: 'hook_disposed',
    specVersion: SPEC_VERSION_CURRENT,
    correlationId: hookId,
  });
}

/**
 * Create a new wait through the wait_created event.
 */
export async function createWait(
  storage: Storage,
  runId: string,
  data: {
    waitId: string;
    resumeAt: Date;
  }
): Promise<Wait> {
  const result = await storage.events.create(runId, {
    eventType: 'wait_created',
    specVersion: SPEC_VERSION_CURRENT,
    correlationId: data.waitId,
    eventData: { resumeAt: data.resumeAt },
  });
  if (!result.wait) {
    throw new Error('Expected wait to be created');
  }
  return result.wait;
}

/**
 * Complete a wait through the wait_completed event.
 */
export async function completeWait(
  storage: Storage,
  runId: string,
  waitId: string
): Promise<Wait> {
  const result = await storage.events.create(runId, {
    eventType: 'wait_completed',
    specVersion: SPEC_VERSION_CURRENT,
    correlationId: waitId,
  });
  if (!result.wait) {
    throw new Error('Expected wait to be completed');
  }
  return result.wait;
}
