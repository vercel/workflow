import { WorkflowRuntimeError } from '@workflow/errors';
import { globalSingleton } from '@workflow/utils';
import type {
  DeploymentGlobalStreamEncryptionEnvelope,
  GlobalStreamEncryptionEnvelope,
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
const envelopeCache = globalSingleton(
  '@workflow/core//globalStreamEnvelopes',
  1,
  () => new Map<string, Promise<GlobalStreamEncryptionEnvelope | null>>()
);

type ResolvedGlobalStream = {
  envelope: DeploymentGlobalStreamEncryptionEnvelope;
  keys: RunPayloadKeys;
};

type GlobalStreamWritableState = {
  envelope: DeploymentGlobalStreamEncryptionEnvelope;
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

function requireDeploymentEnvelope(
  envelope: GlobalStreamEncryptionEnvelope | null | undefined
): DeploymentGlobalStreamEncryptionEnvelope {
  if (
    !envelope ||
    envelope.v !== 1 ||
    envelope.s !== 'dpl' ||
    typeof envelope.d !== 'string' ||
    typeof envelope.k !== 'string'
  ) {
    throw new WorkflowRuntimeError(
      `Unsupported or missing global stream encryption envelope`
    );
  }
  return envelope as DeploymentGlobalStreamEncryptionEnvelope;
}

function canonicalEnvelope(envelope: GlobalStreamEncryptionEnvelope): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(envelope).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0
      )
    )
  );
}

async function stateForEnvelope(
  world: World,
  id: string,
  input: GlobalStreamEncryptionEnvelope
): Promise<GlobalStreamWritableState> {
  const envelope = requireDeploymentEnvelope(input);
  const currentDeploymentId = await world.getDeploymentId();
  if (currentDeploymentId !== envelope.d) {
    const publicKey = decodeRunPublicKey(envelope.k);
    if (!publicKey) {
      throw new WorkflowRuntimeError(
        `Global stream ${id} has an invalid encryption public key`
      );
    }
    return { envelope, key: sealTo(publicKey) };
  }
  const keys = await deriveKeys(world, id, envelope.d);
  if (bytesToBase64(keys.keyPair.publicKey) !== envelope.k) {
    const publicKey = decodeRunPublicKey(envelope.k);
    if (!publicKey) {
      throw new WorkflowRuntimeError(
        `Global stream ${id} has an invalid encryption public key`
      );
    }
    return { envelope, key: sealTo(publicKey) };
  }
  return { envelope, key: keys };
}

async function resolveEnvelope(
  id: string
): Promise<GlobalStreamEncryptionEnvelope | null> {
  let cached = envelopeCache.get(id);
  if (!cached) {
    cached = (async () => {
      const world = await getWorldLazy();
      const info = await requireGlobalStreams(world).getInfo(id);
      return info.encryption;
    })();
    envelopeCache.set(id, cached);
    cached.then(
      (envelope) => {
        if (!envelope) envelopeCache.delete(id);
      },
      () => envelopeCache.delete(id)
    );
  }
  return cached;
}

async function resolveReadableState(id: string): Promise<ResolvedGlobalStream> {
  let cached = keyCache.get(id);
  if (!cached) {
    cached = (async () => {
      const world = await getWorldLazy();
      let envelopeValue = await resolveEnvelope(id);
      while (!envelopeValue) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        envelopeValue = await resolveEnvelope(id);
      }
      const envelope = requireDeploymentEnvelope(envelopeValue);
      let keys = await deriveKeys(world, id, envelope.d);
      if (bytesToBase64(keys.keyPair.publicKey) !== envelope.k) {
        if ((await world.getDeploymentId()) === envelope.d) {
          keys = await deriveKeys(world, id, envelope.d, true);
        }
        if (bytesToBase64(keys.keyPair.publicKey) !== envelope.k) {
          throw new WorkflowRuntimeError(
            `Global stream ${id} encryption envelope does not match its deployment key`
          );
        }
      }
      return { envelope, keys };
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
  let existing: GlobalStreamEncryptionEnvelope | null = null;
  try {
    existing = await resolveEnvelope(id);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  if (existing) return stateForEnvelope(world, id, existing);

  const deploymentId = await world.getDeploymentId();
  const keys = await deriveKeys(world, id, deploymentId);
  return {
    envelope: {
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
    // refresh the immutable envelope, re-encrypt the retained logical frame,
    // and retry without risking a mixed-key stream.
    const serialize = getSerializeStream(
      getCommonReducers(globalThis),
      undefined
    );
    const refresh = async () => {
      const world = await getWorldLazy();
      requireGlobalStreams(world);
      envelopeCache.delete(this.id);
      return stateForEnvelope(
        world,
        this.id,
        requireDeploymentEnvelope(await resolveEnvelope(this.id))
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
        value: canonicalEnvelope(state.envelope),
      },
    });
    return writable;
  }

  async delete(): Promise<void> {
    const world = await getWorldLazy();
    await requireGlobalStreams(world).delete(this.id);
    keyCache.delete(this.id);
    envelopeCache.delete(this.id);
  }
}

export function getGlobalStream<T = unknown>(id: string): GlobalStream<T> {
  return new GlobalStream<T>(id);
}
