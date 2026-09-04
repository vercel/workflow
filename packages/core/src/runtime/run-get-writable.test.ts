/**
 * `Run#getWritable()` — append access to a stream another run owns,
 * reconstructed from the run ID alone.
 *
 * What these tests pin down is that the handle it returns is indistinguishable
 * from one the owner handed over itself: same `(runId, name)` target, same
 * forwarding symbols, same sealed-frame encoding. The two are produced by
 * different code paths (owner metadata here, a wire descriptor in the
 * reviver), and a divergence between them surfaces as a frame the owner cannot
 * decrypt rather than as a type error, so the encoding is asserted at the byte
 * level rather than by trusting the shape.
 */
import { WorkflowRunNotFoundError } from '@workflow/errors';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { importKey } from '../encryption.js';
import { bytesToBase64, deriveRunKeyPair } from '../sealed-box.js';
import {
  dehydrateStepArguments,
  dehydrateWorkflowArguments,
  hydrateStepArguments,
  hydrateWorkflowArguments,
} from '../serialization.js';
import {
  decrypt as decryptEnvelope,
  runPayloadKeys,
} from '../serialization/encryption.js';
import { hydrateData } from '../serialization-format.js';
import {
  STREAM_NAME_SYMBOL,
  STREAM_SERVER_DEPLOYMENT_ID_SYMBOL,
  STREAM_SERVER_PUBLIC_KEY_SYMBOL,
  STREAM_SERVER_RUN_ID_SYMBOL,
} from '../symbols.js';
import { getWorldLazy } from './get-world-lazy.js';
import { getRun, Run } from './run.js';

vi.mock('../version.js', () => ({ version: '0.0.0-test' }));
vi.mock('./get-world-lazy.js', () => ({ getWorldLazy: vi.fn() }));

const OWNER_RUN_ID = 'wrun_ownerrun';
const OWNER_STREAM = 'strm_ownerrun_user';
const OWNER_MATERIAL = new Uint8Array(32).fill(0x2b);

/**
 * The subset of a run record `getWritable()` reads. `resolveData: 'none'`
 * keeps `deploymentId` and `encryptionPublicKey`, which is the whole reason it
 * can skip resolving payload refs.
 */
function ownerRun(overrides: Record<string, unknown> = {}) {
  return {
    runId: OWNER_RUN_ID,
    status: 'running',
    deploymentId: 'dpl_owner',
    ...overrides,
  };
}

function mockWorld(overrides: Record<string, unknown> = {}) {
  const world = {
    runs: { get: vi.fn().mockResolvedValue(ownerRun()) },
    streams: {
      write: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      getInfo: vi.fn().mockResolvedValue({ tailIndex: -1, done: false }),
    },
    ...overrides,
  } as any;
  vi.mocked(getWorldLazy).mockReturnValue(world);
  return world;
}

/** Frames the sink actually received, in order. */
function framesWritten(world: any): Uint8Array[] {
  return world.streams.write.mock.calls
    .map((c: any[]) => c[2])
    .filter((c: unknown) => c instanceof Uint8Array);
}

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('Run#getWritable', () => {
  it('targets the owner run default stream', async () => {
    const world = mockWorld();

    const ops: Promise<any>[] = [];
    const writable = await getRun(OWNER_RUN_ID).getWritable<string>({ ops });
    const writer = writable.getWriter();
    await writer.write('from-a-contributor');
    writer.releaseLock();
    await Promise.all(ops);

    expect(world.runs.get).toHaveBeenCalledWith(OWNER_RUN_ID, {
      resolveData: 'none',
    });
    expect(world.streams.write).toHaveBeenCalled();
    for (const call of world.streams.write.mock.calls) {
      expect(call[0]).toBe(OWNER_RUN_ID);
      expect(call[1]).toBe(OWNER_STREAM);
    }
  });

  it('targets the owner run namespaced stream', async () => {
    const world = mockWorld();

    const ops: Promise<any>[] = [];
    const writable = await getRun(OWNER_RUN_ID).getWritable<string>({
      namespace: 'session-events',
      ops,
    });
    const writer = writable.getWriter();
    await writer.write('namespaced');
    writer.releaseLock();
    await Promise.all(ops);

    // base64url('session-events'), appended to the run's default stream name.
    const expected = `${OWNER_STREAM}_c2Vzc2lvbi1ldmVudHM`;
    expect(world.streams.write.mock.calls[0][1]).toBe(expected);
    expect((writable as any)[STREAM_NAME_SYMBOL]).toBe(expected);
  });

  it('rejects for a run that does not exist', async () => {
    // The API reconstructs a handle onto an existing stream; it must never
    // bring a run or a stream into being as a side effect of asking for one.
    const world = mockWorld({
      runs: {
        get: vi
          .fn()
          .mockRejectedValue(new WorkflowRunNotFoundError('wrun_ghost')),
      },
    });

    await expect(getRun('wrun_ghost').getWritable()).rejects.toThrow(
      WorkflowRunNotFoundError
    );
    expect(world.streams.write).not.toHaveBeenCalled();
    // Fail fast: one look, no backoff, for an ID the caller supplied.
    expect(world.runs.get).toHaveBeenCalledTimes(1);
  });

  it('seals to the owner public key without resolving a symmetric key', async () => {
    // The owner published its X25519 public key, so the contributor can seal
    // with no key-API round trip — and, more importantly, without ever holding
    // a key that could read the stream back.
    const ownerKeyPair = await deriveRunKeyPair(OWNER_MATERIAL);
    const getEncryptionKeyForRun = vi.fn();
    const world = mockWorld({
      getEncryptionKeyForRun,
      runs: {
        get: vi.fn().mockResolvedValue(
          ownerRun({
            encryptionPublicKey: bytesToBase64(ownerKeyPair.publicKey),
          })
        ),
      },
    });

    const ops: Promise<any>[] = [];
    const writable = await getRun(OWNER_RUN_ID).getWritable<string>({ ops });
    const writer = writable.getWriter();
    await writer.write('sealed-to-owner');
    writer.releaseLock();
    await Promise.all(ops);

    expect(getEncryptionKeyForRun).not.toHaveBeenCalled();

    const frames = framesWritten(world);
    expect(frames.length).toBeGreaterThan(0);
    // [4-byte length][encp][sealed...]
    expect(new TextDecoder().decode(frames[0].subarray(4, 8))).toBe('encp');

    // And the owner really can open it.
    const ownerKeys = runPayloadKeys(
      await importKey(OWNER_MATERIAL),
      ownerKeyPair
    );
    const opened = await decryptEnvelope(frames[0].subarray(4), ownerKeys);
    expect(hydrateData(opened as Uint8Array, {})).toBe('sealed-to-owner');
  });

  it('falls back to the owner deployment key when it published no public key', async () => {
    // Runs created by older SDKs carry no public key. They still have to be
    // writable, via the symmetric key imported encrypt-only.
    const getEncryptionKeyForRun = vi.fn().mockResolvedValue(OWNER_MATERIAL);
    const world = mockWorld({ getEncryptionKeyForRun });

    const ops: Promise<any>[] = [];
    const writable = await getRun(OWNER_RUN_ID).getWritable<string>({ ops });
    const writer = writable.getWriter();
    await writer.write('legacy-owner');
    writer.releaseLock();
    await Promise.all(ops);

    // Resolved from the deployment on the run record, so the tier that has to
    // load the owning run first never runs.
    expect(getEncryptionKeyForRun).toHaveBeenCalledWith(OWNER_RUN_ID, {
      deploymentId: 'dpl_owner',
    });
    expect(world.runs.get).toHaveBeenCalledTimes(1);

    const frames = framesWritten(world);
    expect(new TextDecoder().decode(frames[0].subarray(4, 8))).toBe('encr');
  });

  it('carries every forwarding symbol on the returned handle', async () => {
    const ownerKeyPair = await deriveRunKeyPair(OWNER_MATERIAL);
    const ownerPublicKey = bytesToBase64(ownerKeyPair.publicKey);
    mockWorld({
      runs: {
        get: vi
          .fn()
          .mockResolvedValue(ownerRun({ encryptionPublicKey: ownerPublicKey })),
      },
    });

    const writable = await getRun(OWNER_RUN_ID).getWritable();

    expect((writable as any)[STREAM_NAME_SYMBOL]).toBe(OWNER_STREAM);
    expect((writable as any)[STREAM_SERVER_RUN_ID_SYMBOL]).toBe(OWNER_RUN_ID);
    expect((writable as any)[STREAM_SERVER_DEPLOYMENT_ID_SYMBOL]).toBe(
      'dpl_owner'
    );
    expect((writable as any)[STREAM_SERVER_PUBLIC_KEY_SYMBOL]).toBe(
      ownerPublicKey
    );
  });

  it('does not advertise a public key the owner never published', async () => {
    // Stamping one here would send later contributors to seal to an address
    // the owner cannot open.
    mockWorld({ getEncryptionKeyForRun: vi.fn().mockResolvedValue(undefined) });

    const writable = await getRun(OWNER_RUN_ID).getWritable();

    expect((writable as any)[STREAM_SERVER_PUBLIC_KEY_SYMBOL]).toBeUndefined();
  });

  it('keeps the owner identity through start() and into a step', async () => {
    // The motivating shape: a turn workflow holding only the holder run's ID
    // opens a writable, hands it to the workflow it starts, and that workflow
    // hands it to the step that writes. Two serialization hops, and the owner
    // must survive both or the writes land on the wrong stream.
    const ownerKeyPair = await deriveRunKeyPair(OWNER_MATERIAL);
    const ownerPublicKey = bytesToBase64(ownerKeyPair.publicKey);
    const world = mockWorld({
      runs: {
        get: vi
          .fn()
          .mockResolvedValue(ownerRun({ encryptionPublicKey: ownerPublicKey })),
      },
      getEncryptionKeyForRun: vi.fn(),
    });

    const writable = await getRun(OWNER_RUN_ID).getWritable<string>();

    // Hop 1: start() dehydrates into the turn workflow's arguments.
    const forwarded = await dehydrateWorkflowArguments(
      writable,
      'wrun_turn',
      undefined
    );
    const inWorkflow = (await hydrateWorkflowArguments(
      forwarded,
      'wrun_turn',
      undefined
    )) as WritableStream<string>;
    expect((inWorkflow as any)[STREAM_SERVER_RUN_ID_SYMBOL]).toBe(OWNER_RUN_ID);
    expect((inWorkflow as any)[STREAM_SERVER_PUBLIC_KEY_SYMBOL]).toBe(
      ownerPublicKey
    );

    // Hop 2: the workflow passes it into the step that writes.
    const toStep = await dehydrateStepArguments(
      inWorkflow,
      'wrun_turn',
      undefined
    );
    const ops: Promise<any>[] = [];
    const inStep = (await hydrateStepArguments(
      toStep,
      'wrun_turn',
      undefined,
      ops,
      globalThis,
      {},
      'dpl_turn'
    )) as WritableStream<string>;

    const writer = inStep.getWriter();
    await writer.write('written-two-hops-away');
    writer.releaseLock();
    await Promise.all(ops);

    // Still the owner's stream, still sealed, still no key lookup.
    expect(world.getEncryptionKeyForRun).not.toHaveBeenCalled();
    const ownerFrames = world.streams.write.mock.calls.filter(
      (c: any[]) => c[0] === OWNER_RUN_ID && c[1] === OWNER_STREAM
    );
    expect(ownerFrames.length).toBeGreaterThan(0);

    const ownerKeys = runPayloadKeys(
      await importKey(OWNER_MATERIAL),
      ownerKeyPair
    );
    const frame = ownerFrames[0][2] as Uint8Array;
    const opened = await decryptEnvelope(frame.subarray(4), ownerKeys);
    expect(hydrateData(opened as Uint8Array, {})).toBe('written-two-hops-away');
  });

  it('drains on lock release without closing the shared stream', async () => {
    // The contract that makes this safe for per-turn contributors: releasing
    // the writer settles the flush, so nobody has to close a stream they do
    // not own just to get their writes out.
    const world = mockWorld();

    const ops: Promise<any>[] = [];
    const writable = await getRun(OWNER_RUN_ID).getWritable<string>({ ops });
    const writer = writable.getWriter();
    await writer.write('flushed-without-close');
    writer.releaseLock();

    await Promise.all(ops);

    expect(world.streams.write).toHaveBeenCalled();
    expect(world.streams.close).not.toHaveBeenCalled();
  });

  it('closes the owner stream when the caller closes the handle', async () => {
    // Documented consequence rather than a feature: this handle is a normal
    // WritableStream, so close() ends the shared stream for every writer.
    const world = mockWorld();

    const ops: Promise<any>[] = [];
    const writable = await getRun(OWNER_RUN_ID).getWritable<string>({ ops });
    const writer = writable.getWriter();
    await writer.write('last-chunk');
    await writer.close();
    await Promise.all(ops);

    expect(world.streams.close).toHaveBeenCalledWith(
      OWNER_RUN_ID,
      OWNER_STREAM
    );
  });

  it('retries a missing run only for a resiliently started run', async () => {
    // A Run handed back by an optimistic start() may legitimately not exist
    // yet. Same bounded budget the return-value poll uses; no open-ended
    // polling, and getRun() never opts into it.
    vi.useFakeTimers();
    const runsGet = vi
      .fn()
      .mockRejectedValueOnce(new WorkflowRunNotFoundError(OWNER_RUN_ID))
      .mockResolvedValue(ownerRun());
    mockWorld({ runs: { get: runsGet } });

    const pending = new Run(OWNER_RUN_ID, {
      resilientStart: true,
    }).getWritable();

    await vi.advanceTimersByTimeAsync(1_000);
    const writable = await pending;

    expect(runsGet).toHaveBeenCalledTimes(2);
    expect((writable as any)[STREAM_SERVER_RUN_ID_SYMBOL]).toBe(OWNER_RUN_ID);
  });
});
