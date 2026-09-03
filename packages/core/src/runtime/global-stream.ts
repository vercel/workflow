import { WorkflowRuntimeError } from '@workflow/errors';
import { globalSingleton } from '@workflow/utils';
import type {
  DeploymentGlobalStreamEncryption,
  GlobalStreamEncryption,
  GlobalStreamInfoResponse,
  World,
} from '@workflow/world';
import { bytesToBase64, decodeRunPublicKey } from '../sealed-box.js';
import {
  deriveRunPayloadKeys,
  type RunPayloadKeys,
  sealTo,
} from '../serialization/encryption.js';
import { getCommonReducers } from '../serialization/reducers/common.js';
import {
  createReconnectingFramedStream,
  getCommonRevivers,
  getDeserializeStream,
  getSerializeStream,
  WorkflowServerGlobalWritableStream,
} from '../serialization.js';
import {
  STREAM_GLOBAL_ENCRYPTION_SYMBOL,
  STREAM_GLOBAL_ID_SYMBOL,
} from '../symbols.js';
import { getWorldLazy } from './get-world-lazy.js';

const keyCache = globalSingleton(
  '@workflow/core//globalStreamKeys',
  1,
  () => new Map<string, Promise<ResolvedGlobalStream>>()
);
const encryptionCache = globalSingleton(
  '@workflow/core//globalStreamEncryption',
  1,
  () => new Map<string, Promise<GlobalStreamEncryption | null>>()
);

type ResolvedGlobalStream = {
  encryption: DeploymentGlobalStreamEncryption;
  keys: RunPayloadKeys;
};

type GlobalStreamWritableState = {
  encryption: DeploymentGlobalStreamEncryption;
  key: RunPayloadKeys | ReturnType<typeof sealTo>;
};

function unsupported(): never {
  throw new WorkflowRuntimeError(
    'Global streams are not supported by the configured World'
  );
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    (error as { status?: unknown }).status === 404
  );
}

function requireGlobalStreams(
  world: World
): NonNullable<World['globalStreams']> {
  return world.globalStreams ?? unsupported();
}

async function deriveKeys(
  world: World,
  id: string,
  anchorDeploymentId: string,
  forceRemote = false
): Promise<RunPayloadKeys> {
  if (!world.getEncryptionKeyForRun) {
    throw new WorkflowRuntimeError(
      'Global streams require encryption support from the configured World'
    );
  }
  const context: Record<string, unknown> = {
    deploymentId: anchorDeploymentId,
  };
  if (forceRemote) context.forceRemote = true;
  const material = await world.getEncryptionKeyForRun(id, context);
  if (!material) {
    throw new WorkflowRuntimeError(
      `No encryption key is available for global stream ${id}`
    );
  }
  return deriveRunPayloadKeys(material);
}

function requireDeploymentEncryption(
  encryption: GlobalStreamEncryption | null | undefined
): DeploymentGlobalStreamEncryption {
  if (
    !encryption ||
    encryption.v !== 1 ||
    encryption.s !== 'dpl' ||
    typeof encryption.d !== 'string' ||
    typeof encryption.k !== 'string'
  ) {
    throw new WorkflowRuntimeError(
      `Unsupported or missing global stream encryption`
    );
  }
  return encryption as DeploymentGlobalStreamEncryption;
}

function canonicalEncryption(encryption: GlobalStreamEncryption): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(encryption).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0
      )
    )
  );
}

async function stateForEncryption(
  world: World,
  id: string,
  input: GlobalStreamEncryption
): Promise<GlobalStreamWritableState> {
  const encryption = requireDeploymentEncryption(input);
  const currentDeploymentId = await world.getDeploymentId();
  if (currentDeploymentId !== encryption.d) {
    const publicKey = decodeRunPublicKey(encryption.k);
    if (!publicKey) {
      throw new WorkflowRuntimeError(
        `Global stream ${id} has an invalid encryption public key`
      );
    }
    return { encryption, key: sealTo(publicKey) };
  }
  const keys = await deriveKeys(world, id, encryption.d);
  if (bytesToBase64(keys.keyPair.publicKey) !== encryption.k) {
    const publicKey = decodeRunPublicKey(encryption.k);
    if (!publicKey) {
      throw new WorkflowRuntimeError(
        `Global stream ${id} has an invalid encryption public key`
      );
    }
    return { encryption, key: sealTo(publicKey) };
  }
  return { encryption, key: keys };
}

async function resolveEncryption(
  id: string
): Promise<GlobalStreamEncryption | null> {
  let cached = encryptionCache.get(id);
  if (!cached) {
    cached = (async () => {
      const world = await getWorldLazy();
      const info = await requireGlobalStreams(world).getInfo(id);
      return info.encryption;
    })();
    encryptionCache.set(id, cached);
    cached.then(
      (encryption) => {
        if (!encryption) encryptionCache.delete(id);
      },
      () => encryptionCache.delete(id)
    );
  }
  return cached;
}

async function resolveReadableState(id: string): Promise<ResolvedGlobalStream> {
  let cached = keyCache.get(id);
  if (!cached) {
    cached = (async () => {
      const world = await getWorldLazy();
      let encryptionValue = await resolveEncryption(id);
      while (!encryptionValue) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        encryptionValue = await resolveEncryption(id);
      }
      const encryption = requireDeploymentEncryption(encryptionValue);
      let keys = await deriveKeys(world, id, encryption.d);
      if (bytesToBase64(keys.keyPair.publicKey) !== encryption.k) {
        if ((await world.getDeploymentId()) === encryption.d) {
          keys = await deriveKeys(world, id, encryption.d, true);
        }
        if (bytesToBase64(keys.keyPair.publicKey) !== encryption.k) {
          throw new WorkflowRuntimeError(
            `Global stream ${id} encryption does not match its deployment key`
          );
        }
      }
      return { encryption, keys };
    })();
    keyCache.set(id, cached);
    cached.catch(() => keyCache.delete(id));
  }
  return cached;
}

async function resolveWritableState(
  id: string
): Promise<GlobalStreamWritableState> {
  const world = await getWorldLazy();
  requireGlobalStreams(world);
  let existing: GlobalStreamEncryption | null = null;
  try {
    existing = await resolveEncryption(id);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  if (existing) return stateForEncryption(world, id, existing);

  const deploymentId = await world.getDeploymentId();
  const keys = await deriveKeys(world, id, deploymentId);
  return {
    encryption: {
      v: 1,
      s: 'dpl',
      d: deploymentId,
      k: bytesToBase64(keys.keyPair.publicKey),
    },
    key: keys,
  };
}

/** Mint a region-routed global stream id through the configured World. */
export async function createGlobalStreamId(): Promise<string> {
  const world = await getWorldLazy();
  if (!world.createGlobalStreamId) unsupported();
  return world.createGlobalStreamId();
}

/** Derive a stable global stream ID for a tenant-scoped application name. */
export async function globalStreamIdFor(options: {
  name: string;
  region?: string;
}): Promise<string> {
  const world = await getWorldLazy();
  if (!world.globalStreamIdFor) unsupported();
  return world.globalStreamIdFor(options);
}

export interface GlobalStreamReadableOptions {
  startIndex?: number;
}

/** A host-side handle for a run-independent global stream. */
export class GlobalStream<T = unknown> {
  constructor(readonly id: string) {
    if (typeof id !== 'string' || !id.startsWith('gstr_')) {
      throw new WorkflowRuntimeError(`Invalid global stream id: ${id}`);
    }
  }

  async getInfo(): Promise<GlobalStreamInfoResponse> {
    const world = await getWorldLazy();
    return requireGlobalStreams(world).getInfo(this.id);
  }

  async getTailIndex(): Promise<number> {
    return (await this.getInfo()).tailIndex;
  }

  getReadable(options: GlobalStreamReadableOptions = {}): ReadableStream<T> {
    const key = () => resolveReadableState(this.id).then((state) => state.keys);
    const raw = createReconnectingFramedStream(
      this.id,
      this.id,
      options.startIndex,
      async () => undefined,
      {
        get: async (startIndex) => {
          const world = await getWorldLazy();
          return requireGlobalStreams(world).get(this.id, startIndex);
        },
        getInfo: () => this.getInfo(),
      }
    );
    return raw.pipeThrough(
      getDeserializeStream(getCommonRevivers(globalThis), key)
    ) as ReadableStream<T>;
  }

  /**
   * Resolve the anchor before returning so the handle can be serialized safely
   * across a subsequent `start()` boundary without an asynchronous race.
   */
  async getWritable(): Promise<WritableStream<T>> {
    const state = await resolveWritableState(this.id);
    // Serialization stays plaintext until the global sink. That lets a 409
    // refresh the immutable encryption, re-encrypt the retained logical frame,
    // and retry without risking a mixed-key stream.
    const serialize = getSerializeStream(
      getCommonReducers(globalThis),
      undefined
    );
    const refresh = async () => {
      const world = await getWorldLazy();
      requireGlobalStreams(world);
      encryptionCache.delete(this.id);
      return stateForEncryption(
        world,
        this.id,
        requireDeploymentEncryption(await resolveEncryption(this.id))
      );
    };
    const sink = new WorkflowServerGlobalWritableStream(
      this.id,
      state,
      refresh
    );
    const pipe = serialize.readable.pipeTo(sink);
    // Observe an early sink failure even if the caller has not closed yet;
    // close() below still awaits the original promise and surfaces it.
    void pipe.catch(() => {});
    const serializer = serialize.writable.getWriter();
    const writable = new WritableStream<T>({
      write: (chunk) => serializer.write(chunk),
      async close() {
        await serializer.close();
        await pipe;
      },
      async abort(reason) {
        await serializer.abort(reason);
        await pipe.catch(() => {});
      },
    });
    Object.defineProperties(writable, {
      [STREAM_GLOBAL_ID_SYMBOL]: { value: this.id },
      [STREAM_GLOBAL_ENCRYPTION_SYMBOL]: {
        value: canonicalEncryption(state.encryption),
      },
    });
    return writable;
  }

  async delete(): Promise<void> {
    const world = await getWorldLazy();
    await requireGlobalStreams(world).delete(this.id);
    keyCache.delete(this.id);
    encryptionCache.delete(this.id);
  }
}

export function getGlobalStream<T = unknown>(id: string): GlobalStream<T> {
  return new GlobalStream<T>(id);
}
