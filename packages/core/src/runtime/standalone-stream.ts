import { WorkflowRuntimeError } from '@workflow/errors';
import { globalSingleton } from '@workflow/utils';
import type {
  DeploymentStandaloneStreamEncryption,
  StandaloneStreamEncryption,
  StandaloneStreamInfoResponse,
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
  WorkflowServerStandaloneWritableStream,
} from '../serialization.js';
import {
  STREAM_STANDALONE_ENCRYPTION_SYMBOL,
  STREAM_STANDALONE_ID_SYMBOL,
} from '../symbols.js';
import { getWorldLazy } from './get-world-lazy.js';

const keyCache = globalSingleton(
  '@workflow/core//standaloneStreamKeys',
  1,
  () => new Map<string, Promise<ResolvedStandaloneStream>>()
);
const encryptionCache = globalSingleton(
  '@workflow/core//standaloneStreamEncryption',
  1,
  () => new Map<string, Promise<StandaloneStreamEncryption | null>>()
);

type ResolvedStandaloneStream = {
  encryption: DeploymentStandaloneStreamEncryption;
  keys: RunPayloadKeys;
};

type StandaloneStreamWritableState = {
  encryption: DeploymentStandaloneStreamEncryption;
  key: RunPayloadKeys | ReturnType<typeof sealTo>;
};

function unsupported(): never {
  throw new WorkflowRuntimeError(
    'Standalone streams are not supported by the configured World'
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

function requireStandaloneStreams(
  world: World
): NonNullable<World['standaloneStreams']> {
  return world.standaloneStreams ?? unsupported();
}

async function deriveKeys(
  world: World,
  id: string,
  anchorDeploymentId: string,
  forceRemote = false
): Promise<RunPayloadKeys> {
  if (!world.getEncryptionKeyForRun) {
    throw new WorkflowRuntimeError(
      'Standalone streams require encryption support from the configured World'
    );
  }
  const context: Record<string, unknown> = {
    deploymentId: anchorDeploymentId,
  };
  if (forceRemote) context.forceRemote = true;
  const material = await world.getEncryptionKeyForRun(id, context);
  if (!material) {
    throw new WorkflowRuntimeError(
      `No encryption key is available for standalone stream ${id}`
    );
  }
  return deriveRunPayloadKeys(material);
}

function requireDeploymentEncryption(
  encryption: StandaloneStreamEncryption | null | undefined
): DeploymentStandaloneStreamEncryption {
  if (
    !encryption ||
    encryption.v !== 1 ||
    encryption.s !== 'dpl' ||
    typeof encryption.d !== 'string' ||
    typeof encryption.k !== 'string'
  ) {
    throw new WorkflowRuntimeError(
      `Unsupported or missing standalone stream encryption`
    );
  }
  return encryption as DeploymentStandaloneStreamEncryption;
}

function canonicalEncryption(encryption: StandaloneStreamEncryption): string {
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
  input: StandaloneStreamEncryption
): Promise<StandaloneStreamWritableState> {
  const encryption = requireDeploymentEncryption(input);
  const currentDeploymentId = await world.getDeploymentId();
  if (currentDeploymentId !== encryption.d) {
    const publicKey = decodeRunPublicKey(encryption.k);
    if (!publicKey) {
      throw new WorkflowRuntimeError(
        `Standalone stream ${id} has an invalid encryption public key`
      );
    }
    return { encryption, key: sealTo(publicKey) };
  }
  const keys = await deriveKeys(world, id, encryption.d);
  if (bytesToBase64(keys.keyPair.publicKey) !== encryption.k) {
    const publicKey = decodeRunPublicKey(encryption.k);
    if (!publicKey) {
      throw new WorkflowRuntimeError(
        `Standalone stream ${id} has an invalid encryption public key`
      );
    }
    return { encryption, key: sealTo(publicKey) };
  }
  return { encryption, key: keys };
}

async function resolveEncryption(
  id: string
): Promise<StandaloneStreamEncryption | null> {
  let cached = encryptionCache.get(id);
  if (!cached) {
    cached = (async () => {
      const world = await getWorldLazy();
      const info = await requireStandaloneStreams(world).getInfo(id);
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

async function resolveReadableState(
  id: string
): Promise<ResolvedStandaloneStream> {
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
            `Standalone stream ${id} encryption does not match its deployment key`
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
): Promise<StandaloneStreamWritableState> {
  const world = await getWorldLazy();
  requireStandaloneStreams(world);
  let existing: StandaloneStreamEncryption | null = null;
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

/** Mint a region-routed standalone stream id through the configured World. */
export async function createStandaloneStreamId(): Promise<string> {
  const world = await getWorldLazy();
  if (!world.createStandaloneStreamId) unsupported();
  return world.createStandaloneStreamId();
}

/** Derive a stable standalone stream ID for a tenant-scoped application name. */
export async function standaloneStreamIdFor(options: {
  name: string;
  region?: string;
}): Promise<string> {
  const world = await getWorldLazy();
  if (!world.standaloneStreamIdFor) unsupported();
  return world.standaloneStreamIdFor(options);
}

export interface StandaloneStreamReadableOptions {
  startIndex?: number;
}

/** A host-side handle for a run-independent standalone stream. */
export class StandaloneStream<T = unknown> {
  constructor(readonly id: string) {
    if (typeof id !== 'string' || !id.startsWith('stnd_')) {
      throw new WorkflowRuntimeError(`Invalid standalone stream id: ${id}`);
    }
  }

  async getInfo(): Promise<StandaloneStreamInfoResponse> {
    const world = await getWorldLazy();
    return requireStandaloneStreams(world).getInfo(this.id);
  }

  async getTailIndex(): Promise<number> {
    return (await this.getInfo()).tailIndex;
  }

  getReadable(
    options: StandaloneStreamReadableOptions = {}
  ): ReadableStream<T> {
    const key = () => resolveReadableState(this.id).then((state) => state.keys);
    const raw = createReconnectingFramedStream(
      this.id,
      this.id,
      options.startIndex,
      async () => undefined,
      {
        get: async (startIndex) => {
          const world = await getWorldLazy();
          return requireStandaloneStreams(world).get(this.id, startIndex);
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
    // Serialization stays plaintext until the standalone sink. That lets a 409
    // refresh the immutable encryption, re-encrypt the retained logical frame,
    // and retry without risking a mixed-key stream.
    const serialize = getSerializeStream(
      getCommonReducers(globalThis),
      undefined
    );
    const refresh = async () => {
      const world = await getWorldLazy();
      requireStandaloneStreams(world);
      encryptionCache.delete(this.id);
      return stateForEncryption(
        world,
        this.id,
        requireDeploymentEncryption(await resolveEncryption(this.id))
      );
    };
    const sink = new WorkflowServerStandaloneWritableStream(
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
      [STREAM_STANDALONE_ID_SYMBOL]: { value: this.id },
      [STREAM_STANDALONE_ENCRYPTION_SYMBOL]: {
        value: canonicalEncryption(state.encryption),
      },
    });
    return writable;
  }

  async delete(): Promise<void> {
    const world = await getWorldLazy();
    await requireStandaloneStreams(world).delete(this.id);
    keyCache.delete(this.id);
    encryptionCache.delete(this.id);
  }
}

export function getStandaloneStream<T = unknown>(
  id: string
): StandaloneStream<T> {
  return new StandaloneStream<T>(id);
}
